#!/usr/bin/env node
/**
 * TWO-PROCESS cluster E2E — a real hub server and a real spoke server, two separate OS processes,
 * two separate CEZ_HOME directories, a real WebSocket between them, and the production enrollment
 * path (`cez cluster enroll` → `cez cluster join`) rather than a test shortcut.
 *
 * WHY THIS EXISTS. Every cluster test before it ran hub and spoke IN ONE PROCESS, where there is a
 * single mutable `process.env`. That makes a whole class of defect invisible by construction: any
 * code that resolves `CEZ_HOME` from ambient `process.env` rather than from an options parameter
 * looks correct, because both "nodes" share the one value. One such defect was already found and
 * fixed in-process (the hub frame router built its home options without `env`, so the hub read and
 * wrote the SPOKE's roster) — but that fix could only be proven by passing `env` explicitly, which
 * is precisely what production does and what a single-process test cannot fail to do.
 *
 * WHAT IT ASSERTS, and each one is chosen because a single-process test cannot make it:
 *   1. The hub stamps the spoke's presence into the HUB's own home.
 *   2. It does NOT stamp it into the SPOKE's home — the negative half, and the one that fails if
 *      any home resolution falls back to ambient env.
 *   3. The spoke's credential lands in the SPOKE's home.
 *   4. A separate CLI process reads what the SERVER process wrote (`cez cluster active` reporting a
 *      real `asOf`), which is a file handoff across two processes and two homes.
 *
 * WHAT IT DOES NOT COVER, stated so nobody reads a pass here as more than it is: real link loss as
 * opposed to a clean shutdown, event volume against the frame budget, and the WebSocket upgrade
 * through Cloudflare Access (a 302 on an upgrade is a failure mode no localhost test produces).
 *
 * Usage:  node .ai/scripts/cluster-two-node-e2e.mjs [--keep]
 *         --keep leaves both homes and the logs on disk for inspection.
 * Requires a build: packages/cezar/dist/index.js. Run `npm run build` first.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = join(REPO_ROOT, 'packages', 'cezar', 'dist', 'index.js');
const KEEP = process.argv.includes('--keep');

const children = [];
const temps = [];
let failures = 0;

function log(...a) {
  console.log('[cluster-e2e]', ...a);
}
function check(name, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function waitHealthy(base, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/v1/health`);
      if (r.ok) return;
      lastErr = `status ${r.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${base} never became healthy within ${timeoutMs}ms (last: ${lastErr})`);
}

function boot(label, home, port, extraEnv) {
  // CEZ_DRY_RUN=1 swaps the agent CLIs for the bundled mock, so booting needs no `claude` login and
  // reaches no network — the same reason test-env-up.sh sets it.
  const env = { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: home, CEZ_CLUSTER: '1', ...extraEnv };
  const child = spawn('node', [ENTRY, '--port', String(port), '--no-open', '--repo', REPO_ROOT], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(String(d)));
  child.stderr.on('data', (d) => lines.push(String(d)));
  children.push({ label, child, lines });
  return child;
}

async function cli(home, args, extraEnv) {
  const env = { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: home, CEZ_CLUSTER: '1', ...extraEnv };
  // Bounded on purpose: an unbounded await here would turn a wedged CLI into a hung E2E with no
  // output, which is the least debuggable failure this script could produce.
  const { stdout } = await execFileAsync('node', [ENTRY, ...args], {
    cwd: REPO_ROOT,
    env,
    timeout: 60_000,
    killSignal: 'SIGTERM',
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function main() {
  if (!existsSync(ENTRY)) {
    console.error(`[cluster-e2e] missing build: ${ENTRY}\nRun \`npm run build\` first.`);
    return 2;
  }

  const hubHome = mkdtempSync(join(tmpdir(), 'cez-e2e-hub-home-'));
  const spokeHome = mkdtempSync(join(tmpdir(), 'cez-e2e-spoke-home-'));
  temps.push(hubHome, spokeHome);
  mkdirSync(hubHome, { recursive: true });
  mkdirSync(spokeHome, { recursive: true });

  const hubPort = await freePort();
  const spokePort = await freePort();
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  const spokeUrl = `http://127.0.0.1:${spokePort}`;
  log(`hub  ${hubUrl}  home=${hubHome}`);
  log(`spoke ${spokeUrl}  home=${spokeHome}`);

  // ORDER MATTERS, and it is the CLI's own documented order (`cez cluster init` → set CEZ_CLUSTER=1
  // and restart → `cez cluster enroll`). Hub-vs-spoke is a ROLE stored in the node identity under
  // CEZ_HOME, not something the environment decides — so a hub with no identity at boot has nothing
  // for the link server to attach as. `init` is idempotent and refuses a role change outright.
  const inited = JSON.parse(await cli(hubHome, ['cluster', 'init', '--name', 'e2e-hub', '--json']));
  if (inited.role !== 'hub') throw new Error(`cluster init did not produce a hub: ${JSON.stringify(inited)}`);
  log(`hub identity ${inited.nodeId}`);

  // Deliberately WITHOUT CEZ_CLUSTER_HUB: that variable is how a SPOKE finds its hub, and pointing
  // the hub at itself invites it to dial its own link. The hub only needs it for the `enroll` call
  // below, where `clusterHubUrl()` reads it to bake a reachable URL into the join code.
  boot('hub', hubHome, hubPort, {});
  await waitHealthy(hubUrl);
  log('hub healthy');

  const enrolled = JSON.parse(await cli(hubHome, ['cluster', 'enroll', '--name', 'e2e-spoke', '--json'], { CEZ_CLUSTER_HUB: hubUrl }));
  if (!enrolled.code) throw new Error(`enroll produced no code: ${JSON.stringify(enrolled)}`);
  log(`minted join code (codeId ${enrolled.codeId})`);

  // The spoke joins BEFORE its server boots: `join` is a CLI-to-hub HTTP call that writes the
  // credential the spoke's runtime will later dial with.
  const joined = JSON.parse(await cli(spokeHome, ['cluster', 'join', enrolled.code, '--name', 'e2e-spoke', '--json']));
  if (!joined.ok) throw new Error(`join refused: ${JSON.stringify(joined)}`);
  log(`spoke joined as ${joined.nodeId} (hub ${joined.hubNodeId})`);

  // CEZ_CLUSTER_HUB is REQUIRED on a spoke, and finding that out is what this harness is for.
  // Omitting it does not mean "unspecified, fall back to the stored credential" — an ABSENT value is
  // read as a positive claim that THIS node is the hub. With a credential saying it is a spoke of
  // someone else, the runtime sees a contradiction and refuses to arm, saying so explicitly:
  //   "enrolled as a spoke of <url>, but the environment says this node is the hub —
  //    refusing to guess which is right; arming nothing until they agree."
  // That is good defensive behaviour (it fails closed and explains itself rather than picking a
  // side), and it is invisible to every in-process test: there, hub and spoke share ONE mutable
  // process.env, so the two claims can never disagree.
  boot('spoke', spokeHome, spokePort, { CEZ_CLUSTER_HUB: hubUrl });
  await waitHealthy(spokeUrl);
  log('spoke healthy — waiting for the first presence beat to be stamped');

  const hubPeersPath = join(hubHome, 'cluster', 'peers.json');
  const spokePeersPath = join(spokeHome, 'cluster', 'peers.json');

  let stamped;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const peers = readJsonIfPresent(hubPeersPath);
    stamped = peers?.nodes?.find((n) => n.nodeId === joined.nodeId && n.lastSeenAt);
    if (stamped) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('\nassertions:');
  check(
    "the hub stamped the spoke's presence in the HUB's own home",
    Boolean(stamped?.lastSeenAt),
    stamped ? undefined : `no stamped row for ${joined.nodeId} in ${hubPeersPath}`,
  );

  // THE NEGATIVE HALF. If any home resolution falls back to ambient process.env, the hub's roster
  // write lands here instead — which is exactly the defect already found in-process.
  const spokePeers = readJsonIfPresent(spokePeersPath);
  const strayInSpoke = spokePeers?.nodes?.find((n) => n.nodeId === joined.nodeId && n.lastSeenAt);
  if (!stamped?.lastSeenAt) {
    // INCONCLUSIVE, not PASS. If no beat was ever stamped anywhere, "nothing in the spoke's home"
    // is true for the wrong reason — it is "not arrived yet" wearing the clothes of "not there".
    // Reporting it as a pass would be the negative control agreeing with the bug.
    console.log('  SKIP  the hub did NOT stamp into the SPOKE\'s home — INCONCLUSIVE, nothing was stamped anywhere');
    failures += 1;
  } else {
    check(
      "the hub did NOT stamp the spoke's roster into the SPOKE's home",
      !strayInSpoke,
      strayInSpoke ? `found a stamped row for ${joined.nodeId} in ${spokePeersPath}` : undefined,
    );
  }

  // The credential is the spoke's own, written by `join` under 0600. Asserted on CONTENT, not on the
  // directory existing: "a cluster dir is present" is satisfied by almost anything, including a dir
  // the hub created for its own reasons. What must be true is that THIS home holds a SPOKE identity
  // pointing at THIS hub — which is also the fact the runtime compares against the environment.
  const spokeCred = readJsonIfPresent(join(spokeHome, 'cluster', 'node.json'));
  check(
    "the spoke's own home holds a SPOKE credential naming this hub",
    spokeCred?.role === 'spoke' && spokeCred?.hubUrl === hubUrl && typeof spokeCred?.secret === 'string',
    spokeCred
      ? `role=${spokeCred.role} hubUrl=${spokeCred.hubUrl} (expected spoke / ${hubUrl})`
      : `no readable credential at ${join(spokeHome, 'cluster', 'node.json')}`,
  );
  // And the hub must NOT have written itself a spoke credential — the mirror of the roster check.
  const hubCred = readJsonIfPresent(join(hubHome, 'cluster', 'node.json'));
  check(
    "the hub's own identity is a HUB, not a spoke of anything",
    hubCred?.role === 'hub',
    hubCred ? `hub identity role=${hubCred.role}` : `no readable identity at ${join(hubHome, 'cluster', 'node.json')}`,
  );

  // A SEPARATE CLI PROCESS reading what the SERVER process wrote — two processes, two homes.
  const active = JSON.parse(await cli(hubHome, ['cluster', 'active', '--json'], { CEZ_CLUSTER_HUB: hubUrl }));
  check(
    'a separate CLI process reads the presence the SERVER wrote (`cluster active` has a real asOf)',
    typeof active.asOf === 'string' && active.asOf.length > 0,
    `asOf was ${JSON.stringify(active.asOf)} — a linked node that has reported must produce one`,
  );

  return failures === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error('[cluster-e2e] ERROR', err instanceof Error ? err.stack : err);
  code = 1;
} finally {
  for (const { label, child, lines } of children) {
    if (code !== 0) {
      const tail = lines.join('').split('\n').slice(-25).join('\n');
      if (tail.trim()) console.error(`\n--- ${label} log tail ---\n${tail}`);
    }
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  // Give them a moment to unwind, then insist.
  await new Promise((r) => setTimeout(r, 500));
  for (const { child } of children) {
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (!KEEP) for (const d of temps) rmSync(d, { recursive: true, force: true });
  else console.log(`[cluster-e2e] --keep: left ${temps.join(' ')}`);
}
console.log(failures === 0 ? '\n[cluster-e2e] all assertions passed' : `\n[cluster-e2e] ${failures} assertion(s) failed`);
process.exit(code);
