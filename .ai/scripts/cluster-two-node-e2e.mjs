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
 * PHASE 1 — LINK. Each assertion is chosen because a single-process test cannot make it:
 *   1. The hub stamps the spoke's presence into the HUB's own home.
 *   2. It does NOT stamp it into the SPOKE's home — the negative half, and the one that fails if
 *      any home resolution falls back to ambient env.
 *   3. The spoke's credential lands in the SPOKE's home.
 *   4. A separate CLI process reads what the SERVER process wrote (`cez cluster active` reporting a
 *      real `asOf`), which is a file handoff across two processes and two homes.
 *
 * PHASE 2 — DISPATCH (added 2026-08-24). Phase 1 proves two nodes can SEE each other; it proves
 * nothing about work moving between them. Phase 2 drives the whole Milestone C path — the hub's
 * autostart reconcile pass → `hub-autostart-dispatch.ts` → `placeRun` → `HubDispatcher#dispatch` →
 * a `dispatch` frame on the wire → the spoke's `offerDispatch` → `startTodoRun` — and proves the
 * far end of it from the SPOKE's own disk.
 *
 * The load-bearing evidence is `author.via`. `startTodoRun` stamps the run record with the `via`
 * its caller passed, and `'cluster-dispatch'` has exactly ONE producer in the tree
 * (`cluster/spoke-runtime.ts#handleDispatch`). A run carrying it on the spoke cannot be produced by
 * the spoke's own autostart (which passes `'todo-autostart'`), by a person, or by an automation. So
 * the positive assertion is not "the hub says it sent something" — it is a run record, on the other
 * machine's disk, that only a received dispatch frame can have written.
 *
 * TWO TODOS, NOT ONE, and the second one is the control that stops the first's negative half being
 * vacuous. `e2e-remote` is pinned to the spoke and must run there; `e2e-local` is pinned to the hub
 * and must run HERE. Without `e2e-local`, "the hub started no run for `e2e-remote`" would pass just
 * as happily on a hub whose run store is broken, whose autostart never fires, or whose repo has no
 * `.ai/cezar` at all. Every negative below names the positive that gives it meaning and reports
 * INCONCLUSIVE — counted as a FAILURE — when that positive did not hold.
 *
 * TWO SETUP STEPS HAVE NO PRODUCTION AFFORDANCE and are done by writing the node identity file
 * directly. They are marked `[NO CLI/ROUTE]` at their call sites. See the report accompanying this
 * change: `setAcceptsDispatch` (`cluster/node-identity.ts`) — the only writer of a node's OWN
 * `acceptsDispatch`, which is the copy `offerDispatch` actually enforces — has no CLI command and
 * no HTTP route, while `cez cluster join`'s own success banner points the operator at
 * `PATCH /api/v1/cluster/nodes/<id>`, a route that writes a DIFFERENT file (`peers.json`'s roster
 * row). This script does both, because a real deployment needs both.
 *
 * REPLICATION IS MEASURED, NOT ASSUMED. `handleDispatch` reads the dispatched todo out of the
 * SPOKE's own `todos.json` and, when it is absent, declines to answer AT ALL — so the record has to
 * already be there, and the only production way for it to get there is replication. Both todos are
 * therefore written on the HUB only, and the spoke's copy is waited for: first on the live link,
 * then through a real spoke RESTART, which is the connect-time-replay path a laptop that was asleep
 * takes. A failure there is reported as a REPLICATION failure and never collapsed into "dispatch
 * did not work" — they are different faults with different fixes.
 *
 * As of 2026-08-24 that probe FAILS, and the cause is one field. `replay.ts#scanForReplay`
 * Decision 1 puts every row with `hubSeq === undefined` into `unordered` and excludes it from every
 * plan; live fan-out (`planReplicaFanout`) only ever runs from an incoming `ops` frame, and a hub
 * has no outbox. Nothing stamps `hubSeq` on a hub-authored row — its only writers are
 * `todos.ts#markStartedWithClaim` (from a hub ack) and `hub-apply.ts` (applying a spoke's op). So a
 * todo filed ON THE MASTER can reach no worker. Demonstrated causally rather than inferred:
 * re-running this script with `hubSeq: 1` added to the hub's row and nothing else changed made
 * connect-time replay deliver it, and the whole chain then ran green from a genuinely replicated
 * record. That one-line change is deliberately NOT in this file — fabricating cluster state to turn
 * a real red green is the opposite of what this script is for.
 *
 * When replication does not deliver, the record is hand-seeded onto the spoke behind a loud `NOTE`
 * so the DISPATCH half is still measured, and every assertion after that line is explicitly running
 * against a seeded record rather than a replicated one.
 *
 * WHAT IT DOES NOT COVER, stated so nobody reads a pass here as more than it is: real link loss as
 * opposed to a clean shutdown, event volume against the frame budget, and the WebSocket upgrade
 * through Cloudflare Access (a 302 on an upgrade is a failure mode no localhost test produces).
 *
 * Usage:  node .ai/scripts/cluster-two-node-e2e.mjs [--keep]
 *         --keep leaves both homes, both repos and the logs on disk for inspection.
 * Requires a build: packages/cezar/dist/index.js. Run `npm run build` first.
 */
import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = join(REPO_ROOT, 'packages', 'cezar', 'dist', 'index.js');
const KEEP = process.argv.includes('--keep');

/** The cluster-wide project identity both nodes confirm a pairing under. Arbitrary (the schema is
 *  `z.string().min(1).max(64)`); it is NOT either node's local project id, which is what
 *  `byNode[nodeId].projectId` carries. */
const PROJECT_KEY = 'e2e-cluster-project';
const REMOTE_TODO_ID = 'e2e-remote';
const LOCAL_TODO_ID = 'e2e-local';

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
/**
 * A negative control whose PRECONDITION did not hold. Counted as a FAILURE, never skipped: this
 * script already learned once that "nothing was stamped in the spoke's home" reads as a pass when
 * nothing was stamped ANYWHERE — "not there" wearing the clothes of "not arrived yet". A negative
 * assertion that cannot distinguish the two is not evidence of anything.
 */
function inconclusive(name, why) {
  failures += 1;
  console.log(`  INCONCLUSIVE (counts as FAIL)  ${name} — ${why}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(250);
  }
  throw new Error(`${base} never became healthy within ${timeoutMs}ms (last: ${lastErr})`);
}

function boot(label, home, port, repoRoot, extraEnv) {
  // CEZ_DRY_RUN=1 swaps the agent CLIs for the bundled mock, so booting needs no `claude` login and
  // reaches no network — the same reason test-env-up.sh sets it.
  const env = { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: home, CEZ_CLUSTER: '1', ...extraEnv };
  // `--repo` is a THROWAWAY git repo per node, never this checkout. Pointing a booted server at
  // `REPO_ROOT` (which this script used to do) arms `watchTodoAutostart` on cezar's own
  // `.ai/cezar/todos.json` — i.e. an E2E run could start real work filed by a real person — and
  // writes run records into the working tree of a repo other agents share.
  const child = spawn('node', [ENTRY, '--port', String(port), '--no-open', '--repo', repoRoot], {
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

/** Everything every process whose label starts with `prefix` has written so far, as one string.
 *  A PREFIX rather than an exact match so a restarted node (`spoke` → `spoke(restart)`) keeps
 *  contributing to the same log — a restart must not silently erase the evidence before it. */
function logText(prefix) {
  return children
    .filter((c) => c.label.startsWith(prefix))
    .map((c) => c.lines.join(''))
    .join('');
}

/** SIGTERM, then SIGKILL if it is still alive, and resolve only once the process has actually
 *  exited — a restart that races the old process's socket teardown reconnects against a hub that
 *  still holds the previous link. */
async function stopChild(label) {
  const entry = children.find((c) => c.label === label);
  if (!entry || entry.child.exitCode !== null) return;
  const exited = new Promise((r) => entry.child.once('exit', r));
  entry.child.kill('SIGTERM');
  const timer = setTimeout(() => {
    try {
      entry.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 5_000);
  timer.unref?.();
  await exited;
  clearTimeout(timer);
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

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/** JSON request against a node's own API. Returns status AND parsed body — a route that answers
 *  200 with a refusal body is a real case here (`POST /cluster/join` does exactly that), so a bare
 *  `res.ok` is never enough to judge one. */
async function api(base, path, init) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Polls `fn` until it returns something truthy, or the deadline passes. Returns `undefined` on
 *  timeout — every caller must treat that as a fact to report, never as a reason to keep going. */
async function waitFor(fn, timeoutMs = 60_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

/**
 * `[NO CLI/ROUTE]` — D11's opt-in, written straight into the node identity file.
 *
 * `cluster/node-identity.ts#setAcceptsDispatch` is the only function that writes this field, and it
 * has zero production callers: no CLI subcommand, no HTTP route. The route the `cez cluster join`
 * banner names — `PATCH /api/v1/cluster/nodes/<id>` — writes `peers.json`'s ROSTER row instead,
 * which is the hub's record of the node, not the node's own copy. Both are needed for a dispatch to
 * land (`hub-candidates.ts` reads the roster to decide eligibility; `spoke-runtime.ts` reads the
 * identity to decide acceptance), so this script sets both, by the only means each one has.
 */
function setOwnAcceptsDispatch(home, value) {
  const path = join(home, 'cluster', 'node.json');
  // Read and validate BEFORE opening for write: `writeFileSync` truncates on open, so a validation
  // that runs after it would report a clean error over a destroyed credential file.
  const identity = readJsonIfPresent(path);
  if (!identity || typeof identity.nodeId !== 'string') {
    throw new Error(`cannot set acceptsDispatch — no readable node identity at ${path}`);
  }
  writeFileSync(path, JSON.stringify({ ...identity, acceptsDispatch: value }, null, 2), { mode: 0o600 });
  return identity.nodeId;
}

/**
 * One bare origin plus two clones of it, each with `.ai/` gitignored.
 *
 * Both halves matter and both are enforcement, not tidiness:
 *  - **An `origin`** makes `projectHasOrigin` true, so `placeRun` does NOT collapse the pool to
 *    "wherever the project already lives" (D12) and a remote placement is a real decision.
 *  - **`.gitignore` carrying `.ai/`** keeps the cockpit's own writes (`todos.json`, `runs.json`,
 *    `runs/`) out of `git status --porcelain`. Without it every node reports `dirty > 0` the moment
 *    it boots, and `dispatchRefusalReason` refuses every dispatch with `dirty` — a self-inflicted
 *    failure that looks exactly like a real one.
 * Both clones sit at the same commit as `origin/main`, so `behind` is 0 on both.
 */
async function makeRepos(root) {
  const commit = async (dir, message) => {
    await git(dir, ['add', '.']);
    await git(dir, [
      '-c', 'user.email=e2e@example.invalid',
      '-c', 'user.name=cluster-e2e',
      'commit', '-m', message,
    ]);
  };

  const originDir = join(root, 'origin.git');
  await git(root, ['-c', 'init.defaultBranch=main', 'init', '--bare', 'origin.git']);

  const seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  await git(seed, ['-c', 'init.defaultBranch=main', 'init']);
  writeFileSync(join(seed, 'README.md'), '# cluster two-node e2e fixture\n');
  writeFileSync(join(seed, '.gitignore'), '.ai/\n');
  await commit(seed, 'seed');
  await git(seed, ['remote', 'add', 'origin', originDir]);
  await git(seed, ['push', '-u', 'origin', 'HEAD:main']);

  await git(root, ['clone', originDir, 'hub-repo']);
  await git(root, ['clone', originDir, 'spoke-repo']);

  // A separate BOOT root per node, distinct from the cluster project. See `pokeProject` for why
  // the cluster project must not be the boot project: the only reconcile trigger available on this
  // machine is `contexts.onContextBuilt`, and the boot context is built before that hook exists.
  const boots = {};
  for (const name of ['hub-boot', 'spoke-boot']) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    await git(dir, ['-c', 'init.defaultBranch=main', 'init']);
    writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
    writeFileSync(join(dir, '.gitignore'), '.ai/\n');
    await commit(dir, 'seed');
    boots[name] = realpathSync(dir);
  }

  // realpath because the workspace registry normalizes roots, and on macOS `/var/folders/...`
  // resolves to `/private/var/folders/...` — `pairedProjectKey` compares roots by string equality.
  return {
    hubRepo: realpathSync(join(root, 'hub-repo')),
    spokeRepo: realpathSync(join(root, 'spoke-repo')),
    hubBoot: boots['hub-boot'],
    spokeBoot: boots['spoke-boot'],
  };
}

/** The boot project's registry row for `repoRoot` in this home's `config.json`. */
function bootProjectFor(home, repoRoot) {
  const config = readJsonIfPresent(join(home, 'config.json'));
  return config?.projects?.find((p) => p.root === repoRoot);
}

function writeTodos(repoRoot, todos) {
  const dataDir = join(repoRoot, '.ai', 'cezar');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'todos.json'), JSON.stringify(todos, null, 2));
}

function readTodo(repoRoot, id) {
  const todos = readJsonIfPresent(join(repoRoot, '.ai', 'cezar', 'todos.json'));
  return Array.isArray(todos) ? todos.find((t) => t.id === id) : undefined;
}

function readRuns(repoRoot) {
  const runs = readJsonIfPresent(join(repoRoot, '.ai', 'cezar', 'runs.json'));
  return Array.isArray(runs) ? runs : [];
}

/**
 * Force a node to run one autostart reconcile pass over `projectId`, by BUILDING that project's
 * context — `GET /api/v1/p/:projectId/todos` goes through `resolveProjectScope`, which calls
 * `contexts.context(id)`, which fires `contexts.onContextBuilt`, which is wired in `server.ts` to
 * `watchTodoAutostart(...)` — and that function's first act is an immediate reconcile pass. It is
 * the same thing that happens when an operator opens a project in the cockpit for the first time.
 *
 * **This exists because `fs.watch` on a DIRECTORY delivers nothing on this machine, so cezar's
 * ordinary live trigger is dead here.** Measured on Darwin 27.0.0 / Node v22.12.0: `fs.watch(dir)`
 * reported zero events for create, modify, rename-over and unlink, under `{}`, `{recursive:true}`
 * and `{persistent:true}`, in `os.tmpdir()`, in `/private/tmp` and in `$HOME`; `fs.watch(file)` and
 * `fs.watchFile` both work. `todos.ts#startWatch` watches the DIRECTORY, so `onTodosChanged` never
 * fires — which kills todo autostart's live path (and the Inbox's live updates, and
 * `reopen-watch.ts`) on this machine, with or without a cluster. Verified independently of the
 * cluster: a single plain server, no `CEZ_CLUSTER`, never starts an `autostart: true` todo written
 * after boot, and starts the identical todo immediately when it is present before boot.
 *
 * **It also removes a race this test should not depend on.** The other reconcile trigger is the
 * boot pass in `createApp`, which runs BEFORE `startServer` arms the cluster policy — so a todo
 * present at boot may be decided under `DISPATCH_LOCAL` and started locally by a hub that is about
 * to become a placer. Building the context long after boot means the armed policy is the one that
 * decides. That is why the cluster project is deliberately NOT the node's boot project: the boot
 * context is built inside `createApp`, before `onContextBuilt` has any subscriber, so poking it
 * would build nothing and fire nothing.
 *
 * Fires once per context — a second poke of an already-built project is a plain read.
 */
async function pokeProject(base, projectId) {
  return api(base, `/api/v1/p/${encodeURIComponent(projectId)}/todos`, { method: 'GET' });
}

/**
 * Everything that decides whether a dispatch is accepted, read from where it actually lives.
 *
 * Printed only on failure, and it exists because the failure it is most likely to explain is
 * INVISIBLE in both logs: when `offerDispatch` refuses, the spoke sends a `freshness` frame
 * carrying `refused` and logs nothing, and `HubDispatcher#recordFreshnessReply` resolves the record
 * to `'refused'` and logs nothing either (the warn branches there fire only for an UNCORRELATED
 * reply). The sweep never sees it, because the record is no longer pending. So a refused dispatch
 * is silent on both sides, and these six values are the only way to say which of the eight
 * `dispatchRefusalReason` gates closed.
 */
async function diagnoseSpoke(spokeHome, spokeRepo, spokeNodeId) {
  const identity = readJsonIfPresent(join(spokeHome, 'cluster', 'node.json'));
  const peers = readJsonIfPresent(join(spokeHome, 'cluster', 'peers.json'));
  const pairing = peers?.pairings?.find((p) => p.projectKey === PROJECT_KEY);
  const lines = [
    `  spoke identity.acceptsDispatch = ${JSON.stringify(identity?.acceptsDispatch)}   (D11, read by offerDispatch)`,
    `  spoke pairing[${PROJECT_KEY}].byNode[${spokeNodeId}] = ${JSON.stringify(pairing?.byNode?.[spokeNodeId])}`,
  ];
  for (const [label, args] of [
    ['git status --porcelain', ['status', '--porcelain']],
    ['git rev-list --left-right --count origin/main...HEAD', ['rev-list', '--left-right', '--count', 'origin/main...HEAD']],
    ['git rev-parse -q --verify MERGE_HEAD', ['rev-parse', '-q', '--verify', 'MERGE_HEAD']],
  ]) {
    try {
      lines.push(`  spoke repo ${label}: ${JSON.stringify((await git(spokeRepo, args)).trim())}`);
    } catch (err) {
      lines.push(`  spoke repo ${label}: <failed: ${err instanceof Error ? err.message : String(err)}>`);
    }
  }
  return lines.join('\n');
}

async function main() {
  if (!existsSync(ENTRY)) {
    console.error(`[cluster-e2e] missing build: ${ENTRY}\nRun \`npm run build\` first.`);
    return 2;
  }

  const hubHome = mkdtempSync(join(tmpdir(), 'cez-e2e-hub-home-'));
  const spokeHome = mkdtempSync(join(tmpdir(), 'cez-e2e-spoke-home-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-e2e-repos-'));
  temps.push(hubHome, spokeHome, repoRoot);
  mkdirSync(hubHome, { recursive: true });
  mkdirSync(spokeHome, { recursive: true });

  const { hubRepo, spokeRepo, hubBoot, spokeBoot } = await makeRepos(realpathSync(repoRoot));
  log(`cluster repos  hub=${hubRepo}  spoke=${spokeRepo}`);
  log(`boot roots     hub=${hubBoot}  spoke=${spokeBoot}`);

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
  const hubNodeId = inited.nodeId;
  log(`hub identity ${hubNodeId}`);

  // `[NO CLI/ROUTE]` — and it must happen BEFORE the hub boots. `startClusterRuntime` loads the
  // identity ONCE and hands it to `createHubAutostartDispatch`, which is where the hub's own
  // candidate gets its `acceptsDispatch`; flipping the file later would not be re-read.
  setOwnAcceptsDispatch(hubHome, true);

  // Deliberately WITHOUT CEZ_CLUSTER_HUB: that variable is how a SPOKE finds its hub, and pointing
  // the hub at itself invites it to dial its own link. The hub only needs it for the `enroll` call
  // below, where `clusterHubUrl()` reads it to bake a reachable URL into the join code.
  boot('hub', hubHome, hubPort, hubBoot, {});
  await waitHealthy(hubUrl);
  log('hub healthy');

  const enrolled = JSON.parse(await cli(hubHome, ['cluster', 'enroll', '--name', 'e2e-spoke', '--json'], { CEZ_CLUSTER_HUB: hubUrl }));
  if (!enrolled.code) throw new Error(`enroll produced no code: ${JSON.stringify(enrolled)}`);
  log(`minted join code (codeId ${enrolled.codeId})`);

  // The spoke joins BEFORE its server boots: `join` is a CLI-to-hub HTTP call that writes the
  // credential the spoke's runtime will later dial with.
  const joined = JSON.parse(await cli(spokeHome, ['cluster', 'join', enrolled.code, '--name', 'e2e-spoke', '--json']));
  if (!joined.ok) throw new Error(`join refused: ${JSON.stringify(joined)}`);
  const spokeNodeId = joined.nodeId;
  log(`spoke joined as ${spokeNodeId} (hub ${joined.hubNodeId})`);

  // `[NO CLI/ROUTE]`, the spoke's half. Read fresh on every dispatch (`discoverOutboxProjects`), so
  // unlike the hub's this one could be flipped after boot — set here purely so both nodes are
  // configured before either is asked to place anything.
  setOwnAcceptsDispatch(spokeHome, true);

  // CEZ_CLUSTER_HUB is REQUIRED on a spoke, and finding that out is what this harness is for.
  // Omitting it does not mean "unspecified, fall back to the stored credential" — an ABSENT value is
  // read as a positive claim that THIS node is the hub. With a credential saying it is a spoke of
  // someone else, the runtime sees a contradiction and refuses to arm, saying so explicitly:
  //   "enrolled as a spoke of <url>, but the environment says this node is the hub —
  //    refusing to guess which is right; arming nothing until they agree."
  // That is good defensive behaviour (it fails closed and explains itself rather than picking a
  // side), and it is invisible to every in-process test: there, hub and spoke share ONE mutable
  // process.env, so the two claims can never disagree.
  boot('spoke', spokeHome, spokePort, spokeBoot, { CEZ_CLUSTER_HUB: hubUrl });
  await waitHealthy(spokeUrl);
  log('spoke healthy — waiting for the first presence beat to be stamped');

  const hubPeersPath = join(hubHome, 'cluster', 'peers.json');
  const spokePeersPath = join(spokeHome, 'cluster', 'peers.json');

  const stamped = await waitFor(() => {
    const peers = readJsonIfPresent(hubPeersPath);
    return peers?.nodes?.find((n) => n.nodeId === spokeNodeId && n.lastSeenAt);
  });

  console.log('\nphase 1 — link:');
  check(
    "the hub stamped the spoke's presence in the HUB's own home",
    Boolean(stamped?.lastSeenAt),
    stamped ? undefined : `no stamped row for ${spokeNodeId} in ${hubPeersPath}`,
  );

  // THE NEGATIVE HALF. If any home resolution falls back to ambient process.env, the hub's roster
  // write lands here instead — which is exactly the defect already found in-process.
  const spokePeers = readJsonIfPresent(spokePeersPath);
  const strayInSpoke = spokePeers?.nodes?.find((n) => n.nodeId === spokeNodeId && n.lastSeenAt);
  if (!stamped?.lastSeenAt) {
    inconclusive(
      "the hub did NOT stamp the spoke's roster into the SPOKE's home",
      'nothing was stamped anywhere, so "not there" is indistinguishable from "not arrived yet"',
    );
  } else {
    check(
      "the hub did NOT stamp the spoke's roster into the SPOKE's home",
      !strayInSpoke,
      strayInSpoke ? `found a stamped row for ${spokeNodeId} in ${spokePeersPath}` : undefined,
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

  // ================================================================================================
  // PHASE 2 — DISPATCH
  // ================================================================================================
  console.log('\nphase 2 — dispatch:');

  // ---- (a) register each repo as a WORKSPACE PROJECT -----------------------------------------
  // `cezar serve --repo <root>` does NOT register the root it serves: `initWorkspace` guards the
  // registration behind `suppressBootRegistration()`, which returns `true` unconditionally (D3 of
  // `2026-08-07-org-scoped-tasks-knowledge.md`). Registration is an explicit act — `cezar projects
  // add <root>`.
  //
  // It is a HARD PRECONDITION for dispatch, not bookkeeping: `hub-autostart-dispatch.ts#
  // pairedProjectKey` resolves `repoRoot` → `projectId` through `config.projects`, and an
  // unregistered root has no row, so it returns `undefined` and the hub answers `{start:'local'}`
  // for every todo — a fully wired cluster that silently never distributes anything, with nothing
  // logged. Discovered by this script failing exactly that way on its first run.
  await cli(hubHome, ['projects', 'add', hubRepo]);
  await cli(spokeHome, ['projects', 'add', spokeRepo]);

  const hubProject = bootProjectFor(hubHome, hubRepo);
  const spokeProject = bootProjectFor(spokeHome, spokeRepo);
  if (!hubProject || !spokeProject) {
    throw new Error(
      `project not registered after \`projects add\`: hub=${JSON.stringify(hubProject)} ` +
        `spoke=${JSON.stringify(spokeProject)} (looked for roots ${hubRepo} / ${spokeRepo}; ` +
        `hub config: ${JSON.stringify(readJsonIfPresent(join(hubHome, 'config.json'))?.projects)})`,
    );
  }
  log(`project ids  hub=${hubProject.id}  spoke=${spokeProject.id}`);

  // ---- (b) acceptsDispatch, the ROSTER half --------------------------------------------------
  // `PATCH /api/v1/cluster/nodes/:nodeId` — gated by `requireCluster` only (CEZ_CLUSTER=1); no hub
  // gate, no node auth, no cockpit session when CEZ_AUTH is unset. It edits `peers.json`'s row, so
  // it is meaningful on whichever node HOLDS a row for that id — the hub. This is the copy
  // `hub-candidates.ts` reads to decide whether the spoke is an eligible placement target.
  const patched = await api(hubUrl, `/api/v1/cluster/nodes/${encodeURIComponent(spokeNodeId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ acceptsDispatch: true }),
  });
  check(
    'PATCH /api/v1/cluster/nodes/:nodeId set acceptsDispatch on the hub\'s roster row for the spoke',
    patched.status === 200 && patched.body?.acceptsDispatch === true,
    `status ${patched.status} body ${JSON.stringify(patched.body)}`,
  );

  // ---- (c) the pairing, confirmed on BOTH sides ----------------------------------------------
  // `POST /api/v1/cluster/pairings/:projectKey {action:'confirm', nodeId, projectId}`. THREE calls,
  // not one, and that is the surface's real shape rather than a quirk of this test:
  //   - the hub's `peers.json` must carry a confirmed row for the HUB (that is what
  //     `pairedProjectKey` resolves `repoRoot` through) AND one for the SPOKE (that is
  //     `holdsProject`, per candidate);
  //   - the spoke's OWN `peers.json` must carry its own row, because `collectPresence` builds
  //     `repoDrift` from it and `handleDispatch` declines to answer at all without a matching
  //     entry.
  // Nothing propagates a pairing between nodes: `welcome` carries the hub's `pairings` on the wire,
  // and `link-client.ts` uses that frame only to mark the link online — it persists none of it.
  const pairingCalls = [
    ['hub', hubUrl, hubNodeId, hubProject.id],
    ['hub', hubUrl, spokeNodeId, spokeProject.id],
    ['spoke', spokeUrl, spokeNodeId, spokeProject.id],
  ];
  const pairingResults = [];
  for (const [where, base, nodeId, projectId] of pairingCalls) {
    const res = await api(base, `/api/v1/cluster/pairings/${encodeURIComponent(PROJECT_KEY)}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'confirm', nodeId, projectId }),
    });
    pairingResults.push({ where, nodeId, projectId, ...res });
  }
  const confirmedOn = (peersPath, nodeId) =>
    readJsonIfPresent(peersPath)?.pairings?.find((p) => p.projectKey === PROJECT_KEY)?.byNode?.[nodeId]?.confirmedAt;
  check(
    'POST /api/v1/cluster/pairings/:projectKey confirmed the project on both nodes',
    Boolean(confirmedOn(hubPeersPath, hubNodeId)) &&
      Boolean(confirmedOn(hubPeersPath, spokeNodeId)) &&
      Boolean(confirmedOn(spokePeersPath, spokeNodeId)),
    `hub[hub]=${confirmedOn(hubPeersPath, hubNodeId)} hub[spoke]=${confirmedOn(hubPeersPath, spokeNodeId)} ` +
      `spoke[spoke]=${confirmedOn(spokePeersPath, spokeNodeId)} · responses ${JSON.stringify(pairingResults)}`,
  );

  // A roster row with no `capacity` is not a candidate at all (`hub-candidates.ts` drops it rather
  // than fabricating `{maxParallel: 0}`), so wait for the beat that carries one before writing any
  // todo. The spoke beats once immediately on arming, so this is normally instant.
  const spokeCapacity = await waitFor(() => {
    const row = readJsonIfPresent(hubPeersPath)?.nodes?.find((n) => n.nodeId === spokeNodeId);
    return row?.capacity ? row : undefined;
  }, 45_000);
  check(
    "the hub's roster carries a real capacity claim for the spoke (a candidate without one is dropped)",
    Boolean(spokeCapacity?.capacity),
    `roster row: ${JSON.stringify(readJsonIfPresent(hubPeersPath)?.nodes?.find((n) => n.nodeId === spokeNodeId))}`,
  );

  // ---- (d) the todos --------------------------------------------------------------------------
  const now = new Date().toISOString();
  const remoteTodo = {
    id: REMOTE_TODO_ID,
    ts: now,
    summary: 'cluster e2e — this one must run on the SPOKE',
    autostart: true,
    // An explicit pin, `ClusterTodoPlacement#node`. Used instead of leaning on the ranking because
    // two idle nodes TIE on headroom and `rankByHeadroom` breaks the tie on `nodeId` ASCENDING —
    // and both ids are `randomUUID()`, so an unpinned todo would land on the spoke about half the
    // time. A coin-flip assertion is worse than no assertion. The hub is still fully eligible here
    // (its own `acceptsDispatch` is on, it holds the project, it has headroom), so `start: 'remote'`
    // remains a decision the placer made rather than the only answer available to it.
    placement: { node: spokeNodeId },
  };
  const localTodo = {
    id: LOCAL_TODO_ID,
    ts: now,
    summary: 'cluster e2e — this one must run on the HUB',
    autostart: true,
    placement: { node: hubNodeId },
  };

  // ---- (e) REPLICATION — measured, because the dispatch depends on it ------------------------
  // `handleDispatch` reads the dispatched todo out of the SPOKE's own `todos.json`
  // (`spoke-runtime.ts:1114`) and, when it is absent, declines to answer AT ALL — no refusal frame,
  // because no wire reason means "I do not hold that record yet" — leaving the hub's record
  // `pending` until the sweep mislabels it `unanswered`. So the spoke MUST already hold the record,
  // and the only production way for it to get there is replication.
  //
  // Both todos are written on the HUB only, and the spoke's copy is then WAITED FOR rather than
  // fabricated. If it never arrives, that is reported as a REPLICATION failure and named as such —
  // it is a different fault from a dispatch that was refused, and collapsing the two is exactly
  // what would let a broken replication path read as a working cluster.
  writeTodos(hubRepo, [remoteTodo, localTodo]);

  const spokeHoldsRemote = () => readTodo(spokeRepo, REMOTE_TODO_ID);

  // Probe 1 — the LIVE link. Live fan-out is `hub-router.ts`'s `ops` case calling
  // `planReplicaFanout`, and nothing else calls it; the outbox flush cadence is 5s
  // (`DEFAULT_OP_FLUSH_MS`), so 30s is ~6 cycles.
  let replicatedBy = (await waitFor(spokeHoldsRemote, 30_000)) ? 'live fan-out' : undefined;

  // Probe 2 — CONNECT-TIME REPLAY, which is the other real path and needs a fresh `hello`. Restart
  // the spoke process rather than simulate one: `link-client.ts` sends `hello` on open, and
  // `hub-router.ts`'s `hello` case calls `scanForReplay` over the hub's own todos for every project
  // the roster says this node is confirmed-paired for. This is the path a laptop that was asleep
  // takes, so it is worth exercising on its own.
  if (!replicatedBy) {
    log('not replicated on the live link within 30s — restarting the spoke to force connect-time replay');
    const restartedAt = Date.now();
    await stopChild('spoke');
    boot('spoke(restart)', spokeHome, spokePort, spokeBoot, { CEZ_CLUSTER_HUB: hubUrl });
    await waitHealthy(spokeUrl);
    // Wait for the hub to see the NEW link, not the old one: `lastSeenAt` must advance past the
    // moment the previous process was killed, or a stale stamp reads as a live reconnection.
    await waitFor(() => {
      const row = readJsonIfPresent(hubPeersPath)?.nodes?.find((n) => n.nodeId === spokeNodeId);
      return row?.lastSeenAt && Date.parse(row.lastSeenAt) > restartedAt ? row : undefined;
    }, 45_000);
    replicatedBy = (await waitFor(spokeHoldsRemote, 30_000)) ? 'connect-time replay' : undefined;
  }

  const hubRemoteBeforeDispatch = readTodo(hubRepo, REMOTE_TODO_ID);
  check(
    'the todo the hub holds REPLICATED to the spoke (the record a dispatch needs at the far end)',
    Boolean(replicatedBy),
    `neither the live link nor a fresh \`hello\` delivered "${REMOTE_TODO_ID}" to ${join(spokeRepo, '.ai/cezar/todos.json')}. ` +
      `The hub's own copy has hubSeq = ${JSON.stringify(hubRemoteBeforeDispatch?.hubSeq)} — ` +
      '`replay.ts#scanForReplay` (Decision 1) puts every `hubSeq === undefined` row in `unordered` and ' +
      'excludes it from every plan, and live fan-out only ever runs from an incoming `ops` frame',
  );
  if (replicatedBy) log(`replicated to the spoke by ${replicatedBy}`);

  // FALLBACK SEED — explicitly labelled, and it runs ONLY when replication did not deliver. The
  // dispatch half is a separate mechanism and is still worth measuring, but a reader must never be
  // able to mistake a green dispatch here for a working end-to-end path.
  if (!replicatedBy) {
    console.log(
      `  NOTE  replication did not deliver the record — hand-seeding it into the spoke's project so the\n` +
        '        DISPATCH half below is still exercised. Every dispatch assertion after this line runs\n' +
        '        against a hand-seeded record, NOT a replicated one.',
    );
    writeTodos(spokeRepo, [remoteTodo]);
  }

  // Poke the SPOKE, and its refusal is an assertion in its own right rather than setup. This makes
  // the spoke run one reconcile pass over a todo that is `autostart: true` and pinned elsewhere:
  // the D9a guard (`createSpokeAutostartCluster#claimStart`) must refuse it out loud. If the guard
  // were broken this pass is exactly what would start the cross-node duplicate — so the negative
  // below is a POSITIVE observation (a named refusal was logged) rather than an absence.
  await pokeProject(spokeUrl, spokeProject.id);
  const spokeRefusal = await waitFor(
    () => new RegExp(`todo autostart refused for "[^"]*" \\(${REMOTE_TODO_ID}\\): (.*)`).exec(logText('spoke')) ?? undefined,
    30_000,
  );
  check(
    'the SPOKE refused to self-start the todo it holds, naming the worker policy',
    Boolean(spokeRefusal) && /cluster worker|hub places its work/.test(spokeRefusal[1]),
    spokeRefusal
      ? `refused with ${JSON.stringify(spokeRefusal[1].trim())}`
      : `the spoke logged no autostart refusal for "${REMOTE_TODO_ID}" within 30s — it either started it (see the run assertions) or never ran a pass`,
  );

  // Now the hub. Both todos were written above in one file, so one reconcile pass makes both
  // decisions — `e2e-remote` pinned to the spoke, `e2e-local` pinned here.
  await pokeProject(hubUrl, hubProject.id);

  // ---- (e) what actually happened -------------------------------------------------------------
  const PLACED_RE = new RegExp(
    `todo autostart placed "[^"]*" \\(${REMOTE_TODO_ID}\\) on node (\\S+) as dispatch (\\S+)`,
  );
  const placedLine = await waitFor(() => PLACED_RE.exec(logText('hub')) ?? undefined, 60_000);

  // The spoke's run is the real evidence. Wait on the STAMP (`markStarted` writes `startedTaskId`
  // and clears `autostart` as the last step of `startTodoRun`), then resolve it in the run index.
  const spokeStarted = await waitFor(() => readTodo(spokeRepo, REMOTE_TODO_ID)?.startedTaskId, 60_000);
  const spokeRuns = readRuns(spokeRepo);
  const spokeRun = spokeRuns.find((r) => r.id === spokeStarted);

  // The hub's local control is matched on the RUN, not on the todo's stamp — the two are separate
  // facts and this test found them disagreeing. `RunRecord#task` is `todoTaskText(todo)`, so the
  // todo's own summary is the link back, and it is the only one available: `startTodoRun` passes
  // `task` + `author` to `manager.startRun` and no `todoId`.
  const hubRun = await waitFor(
    () => readRuns(hubRepo).find((r) => typeof r.task === 'string' && r.task.includes(localTodo.summary)),
    60_000,
  );
  const hubRuns = readRuns(hubRepo);
  const hubStamped = readTodo(hubRepo, LOCAL_TODO_ID)?.startedTaskId;

  const hubRemoteTodo = readTodo(hubRepo, REMOTE_TODO_ID);

  // POSITIVE 1 — the hub's own claim. Necessary, and on its own worth very little: it is the hub
  // reporting what it believes it did.
  check(
    `the hub PLACED "${REMOTE_TODO_ID}" remotely, on the spoke`,
    Boolean(placedLine) && placedLine[1] === spokeNodeId,
    placedLine
      ? `placed on ${placedLine[1]}, expected ${spokeNodeId}`
      : `no placement line for ${REMOTE_TODO_ID} in the hub log within 60s${refusalDetail('hub', REMOTE_TODO_ID)}`,
  );

  // POSITIVE 2 — THE ONE THAT MATTERS. A run record on the SPOKE's disk whose `author.via` is
  // `'cluster-dispatch'`. That string has exactly one producer in the tree
  // (`spoke-runtime.ts#handleDispatch` → `startTodoRun(..., 'cluster-dispatch', …)`), so it cannot
  // be written by the spoke's own autostart, by a person, or by an automation — only by a dispatch
  // frame that arrived over the link and was accepted.
  check(
    `the SPOKE started a real run for "${REMOTE_TODO_ID}", stamped author.via = "cluster-dispatch"`,
    Boolean(spokeRun) && spokeRun.author?.via === 'cluster-dispatch',
    spokeStarted
      ? spokeRun
        ? `run ${spokeRun.id} carries author.via = ${JSON.stringify(spokeRun.author?.via)}`
        : `the spoke's todo names run ${spokeStarted} but no such record is in its runs.json`
      : `the spoke's "${REMOTE_TODO_ID}" was never stamped with a startedTaskId within 60s`,
  );

  // POSITIVE 3a — the LOCAL control, and the ONE the negatives depend on. Its job is to prove this
  // hub's autostart fires and its run store writes; without it, "the hub holds no run for the
  // dispatched todo" would pass on a hub that never started anything at all.
  check(
    `the HUB started a run for "${LOCAL_TODO_ID}" itself, author.via = "todo-autostart"`,
    Boolean(hubRun) && hubRun.author?.via === 'todo-autostart',
    hubRun
      ? `run ${hubRun.id} carries author.via = ${JSON.stringify(hubRun.author?.via)}`
      : `no run whose task text names "${localTodo.summary}" reached the hub's runs.json within 60s` +
        `${refusalDetail('hub', LOCAL_TODO_ID)}`,
  );

  // POSITIVE 3b — the hub STAMPED that run onto the todo record. Split from 3a deliberately,
  // because on a clustered hub these two disagree: the run starts and the stamp is refused
  // `hub-unconfirmed`. `markStartedWithClaim` (`todos.ts`) asks a `TodoStartConfirmer` for the
  // hub's verdict, `confirmStart` has ZERO production callers anywhere in the tree, and the
  // no-confirmer branch refuses unless the caller passed `humanIntent: true` — which
  // `startAutostartTodo`'s local path does not. It is not a cluster-only path either: `POST
  // /todos/:id/start` (the cockpit's ▶ Run) calls `markStarted(dataDir, id, run.id)` with no
  // options at all and discards the boolean, so on any node with `CEZ_CLUSTER=1` a person's own
  // click starts a run the record never records. Asserted separately so a red here cannot be
  // mistaken for the dispatch path failing.
  check(
    `the HUB stamped that run onto "${LOCAL_TODO_ID}" (startedTaskId)`,
    Boolean(hubRun) && hubStamped === hubRun.id,
    `startedTaskId = ${JSON.stringify(hubStamped)}, run = ${JSON.stringify(hubRun?.id)}` +
      `${refusalDetail('hub', LOCAL_TODO_ID)}`,
  );

  // NEGATIVE 1 — the hub did not ALSO run the todo it dispatched. Gated on POSITIVE 3a.
  if (!(hubRun && hubRun.author?.via === 'todo-autostart')) {
    inconclusive(
      `the HUB did NOT also start "${REMOTE_TODO_ID}" locally`,
      `the hub started no run for "${LOCAL_TODO_ID}" either, so an empty hub run set proves nothing about the dispatched todo`,
    );
  } else {
    const strayOnHub = hubRuns.filter((r) => typeof r.task === 'string' && r.task.includes(remoteTodo.summary));
    // Deliberately NOT `startedTaskId === undefined`. That field is expected to become the SPOKE's
    // run id once the claim travels back (POSITIVE 4), so asserting it stays empty would make this
    // control contradict the loop-closure assertion and turn a fully working cluster red. What
    // must be true is narrower and is the actual question: no run in the HUB's OWN run store is
    // this todo's work.
    check(
      `the HUB did NOT also start "${REMOTE_TODO_ID}" locally`,
      strayOnHub.length === 0,
      `hub runs naming the dispatched todo: ${JSON.stringify(strayOnHub.map((r) => ({ id: r.id, via: r.author?.via })))}; ` +
        `hub's "${REMOTE_TODO_ID}".startedTaskId = ${JSON.stringify(hubRemoteTodo?.startedTaskId)}`,
    );
  }

  // POSITIVE 4 — THE LOOP CLOSING, and the strongest single assertion in the file. The spoke stamps
  // its own todo optimistically (`humanIntent: true` → `stampPending`), the ordinary outbox flush
  // derives an op from that `pendingSince` every 5s (`DEFAULT_OP_FLUSH_MS`, `deriveTodoOps`), the
  // hub serializes it through `applyOpAtHub` behind the both-ways-confirmed pairing gate, and the
  // HUB's own copy of the todo gains the claim. Two fields, and both must match a value that was
  // minted on the OTHER machine: `startedTaskId` is the run id the spoke's `RunManager` created,
  // and `startedOn` is the spoke's node id. Nothing on the hub can synthesise either — the hub
  // never writes `startedTaskId` for a dispatch (`hub-dispatch.ts` C-a3: "the run id does not exist
  // until the spoke's `startRun` mints it").
  //
  // Gated on POSITIVE 2: with no run on the spoke there is no claim for the hub to receive, so the
  // absence would mean nothing.
  if (!(spokeRun && spokeRun.author?.via === 'cluster-dispatch')) {
    inconclusive(
      "the SPOKE's claim travelled back and stamped the HUB's copy of the todo",
      'the spoke started no dispatched run, so there was no claim op for the outbox to carry',
    );
  } else {
    const claimed = await waitFor(() => {
      const todo = readTodo(hubRepo, REMOTE_TODO_ID);
      return todo?.startedTaskId ? todo : undefined;
    }, 60_000);
    check(
      "the SPOKE's claim travelled back and stamped the HUB's copy of the todo",
      claimed?.startedTaskId === spokeRun.id && claimed?.startedOn === spokeNodeId,
      claimed
        ? `hub's copy has startedTaskId=${JSON.stringify(claimed.startedTaskId)} startedOn=${JSON.stringify(claimed.startedOn)}; ` +
          `expected ${JSON.stringify(spokeRun.id)} / ${JSON.stringify(spokeNodeId)}`
        : `the hub's "${REMOTE_TODO_ID}" gained no startedTaskId within 60s of the spoke starting run ${spokeRun.id} — ` +
          "the outbox never carried the spoke's claim back",
    );
  }

  // NEGATIVE 2 — the spoke did not SELF-start the todo it was holding. This is the D9a guard
  // (`createSpokeAutostartCluster#claimStart` refusing unconditionally while the hub is reachable),
  // and it is exactly the cross-node duplicate the whole design exists to prevent. Gated on
  // POSITIVE 2: with no run on the spoke at all, "no self-started run" is true for the wrong reason.
  if (!(spokeRun && spokeRun.author?.via === 'cluster-dispatch')) {
    inconclusive(
      'the SPOKE did not self-start the replicated todo (a worker waits to be dispatched)',
      'no dispatched run exists on the spoke either, so an empty spoke run set proves nothing about the guard',
    );
  } else {
    const selfStarted = spokeRuns.filter((r) => r.author?.via === 'todo-autostart');
    check(
      'the SPOKE did not self-start the replicated todo (a worker waits to be dispatched)',
      selfStarted.length === 0,
      `spoke runs carrying via "todo-autostart": ${JSON.stringify(selfStarted.map((r) => r.id))}`,
    );
  }

  // ---- the outcome, named ---------------------------------------------------------------------
  console.log('\nplacement outcome:');
  if (placedLine) {
    console.log(`  "${REMOTE_TODO_ID}"  placed-remote on ${placedLine[1]} as dispatch ${placedLine[2]}`);
  } else {
    const refusal = refusalDetail('hub', REMOTE_TODO_ID);
    console.log(`  "${REMOTE_TODO_ID}"  NOT placed remotely.${refusal || ' No refusal was logged either.'}`);
  }
  console.log(
    `  "${LOCAL_TODO_ID}"  ${
      hubRun
        ? `placed-local, run ${hubRun.id}${hubStamped === hubRun.id ? ' (stamped)' : ' — NOT STAMPED onto the record'}`
        : `no local run${refusalDetail('hub', LOCAL_TODO_ID) || ''}`
    }`,
  );
  console.log(
    `  spoke run for "${REMOTE_TODO_ID}": ${spokeRun ? `${spokeRun.id} (via ${spokeRun.author?.via})` : 'NONE'}`,
  );

  if (!spokeRun) {
    console.log('\nwhy the spoke may not have started it — a refused dispatch is SILENT on both sides:');
    console.log(await diagnoseSpoke(spokeHome, spokeRepo, spokeNodeId));
    const spokeWarnings = logText('spoke')
      .split('\n')
      .filter((l) => l.includes('cluster spoke:'))
      .slice(-12);
    if (spokeWarnings.length > 0) console.log(`  spoke cluster log:\n    ${spokeWarnings.join('\n    ')}`);
  }

  return failures === 0 ? 0 : 1;
}

/** The verbatim `[cez] todo autostart refused for "…" (<id>): <reason>` line, if one was written.
 *  That `<reason>` is `ClusterPlacementResult#detail ?? #reason` for a queued placement and the
 *  blocking run for a blocked one — the single most useful string this script can surface, so it is
 *  never paraphrased. */
function refusalDetail(label, todoId) {
  const re = new RegExp(`todo autostart refused for "[^"]*" \\(${todoId}\\): (.*)`);
  const match = re.exec(logText(label));
  return match ? `  refusal logged: ${JSON.stringify(match[1].trim())}` : '';
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
      const tail = lines.join('').split('\n').slice(-40).join('\n');
      if (tail.trim()) console.error(`\n--- ${label} log tail ---\n${tail}`);
    }
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  // Give them a moment to unwind, then insist.
  await sleep(500);
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
// Keyed on `code`, never on `failures` alone. A THROW out of `main()` (a precondition that could
// not be met, so no assertion ever ran) leaves `failures === 0`, and this line used to print "all
// assertions passed" directly underneath the stack trace of the error that stopped it.
console.log(
  code === 0
    ? '\n[cluster-e2e] all assertions passed'
    : failures > 0
      ? `\n[cluster-e2e] ${failures} assertion(s) failed`
      : '\n[cluster-e2e] FAILED before the assertions ran — see the error above',
);
process.exit(code);
