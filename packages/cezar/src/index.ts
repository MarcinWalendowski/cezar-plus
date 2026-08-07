#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectEnvironment } from './core/backend-detect.ts';
import {
  ProviderAuthService,
  providerAuthChecksDisabled,
} from './core/provider-auth.ts';
import { applyProviderEnablement } from './core/provider-availability.ts';
import { pruneOrphans } from './git-worktree.ts';
import { getRepoInfo } from './server/git.ts';
import { DEFAULT_WORKTREE_RETENTION, loadConfig, resolveWorktreeRetention } from './config.ts';
import { reclaimWorktrees } from './runs/retention.ts';
import { RunStore } from './runs/store.ts';
import { RunManager } from './workflows/run.ts';
import { loadWorkflows } from './workflows/load.ts';
import { startServer, WorkspaceEventBus, type SessionResolver } from './server/server.ts';
import { runAuthBootGate } from './auth-boot-gate.ts';
import type { Hono } from 'hono';
import {
  ProviderRuntimeAuthObserver,
  recoverWithProviderRuntimeAuthObservation,
} from './server/provider-auth-runtime.ts';
import {
  providersRequiredByWorkflow,
  unavailableProviderMessage,
} from './server/provider-action-gate.ts';
import { checkForUpdate } from './update-check.ts';
import { printSkillsBanner } from './skills-banner.ts';
import { loadWorkspaceConfig } from './workspace/config.ts';
import { runMigrations } from './workspace/migrations.ts';
import { registerProject, shouldRegisterProject } from './workspace/projects.ts';
import { runProjectsCommand } from './workspace/projects-cli.ts';
import { WorkspaceSemaphore } from './workspace/semaphore.ts';

const HELP = `cezar — local cockpit for AI agent tasks in your repo

Usage:
  cezar                     start the cockpit (server + GUI) for the current repo
  cezar run "<task>"        run a task headless in the terminal
  cezar init                scaffold .ai/cezar/ (example workflow + skill)
  cezar projects            list the projects this cockpit serves
                            (also: projects add [<dir>] · projects remove <id>)
  cezar server-install      interactive wizard to host cezar on a server
  cezar server-deploy       redeploy a new version (reload the service) + verify
  cezar server-uninstall    reverse a server-install

Options:
  -p, --port <n>              cockpit port (default 4321; server-install: this
                              instance's loopback port — auto-picked per domain)
      --repo <dir>            repo to operate on (default: cwd)
      --workflow <name>       workflow for \`run\` (default: quick-task)
      --model <model>         model override for \`run\`
      --no-open               don't open the browser
      --platform <id>         server-install target (ubuntu-vps | macosx-ngrok)
      --domain <host>         server-install (ubuntu-vps): host a SECOND, independent
                              cockpit for this domain (own nginx site + service + port).
                              A new domain never resumes/clobbers the first install.
      --external-proxy        server-install (ubuntu-vps): the box ALREADY has a
                              reverse proxy owning :80/:443 (Dokploy/Traefik, Coolify,
                              Caddy, your own nginx). Installs the service only — no
                              nginx, no certbot. That proxy must provide TLS + auth.
      --bind-host <host>      host the cockpit binds (default 127.0.0.1). Use with
                              --external-proxy when the proxy runs in a container and
                              cannot reach loopback (e.g. docker bridge 172.17.0.1).
                              cezar has NO built-in auth — never expose this publicly.
      --yes                   server-install: accept safe defaults (never auto-sudo)
      --reconfigure <ids>     server-install: force re-run of step id(s), comma-separated
      --reinstall             server-install: force re-run of every step (full reinstall)
  -h, --help                  show this help

Zero config: uses your logged-in \`claude\` CLI (and \`gh\` for GitHub bits).
Skills live in .ai/skills/, .ai/cezar/skills/ and your team skills repo
(default open-mercato/skills; override via .ai/cezar/config.json);
workflows in .ai/cezar/workflows/.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      port: { type: 'string', short: 'p', default: '4321' },
      repo: { type: 'string' },
      workflow: { type: 'string' },
      model: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      platform: { type: 'string' },
      domain: { type: 'string' },
      'bind-host': { type: 'string' },
      'external-proxy': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      reconfigure: { type: 'string' },
      reinstall: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  // `port` carries a default, so its presence can't tell an explicit `--port`
  // from the fallback. server-install needs that distinction (explicit port
  // wins; otherwise a new named instance auto-picks a free one), so detect the
  // flag straight from argv.
  const portExplicit = process.argv
    .slice(2)
    .some((a) => a === '-p' || a === '--port' || a.startsWith('--port=') || a.startsWith('-p='));

  if (values.help) {
    console.log(HELP);
    return;
  }

  const command = positionals[0] ?? 'serve';
  const cwd = resolve(values.repo ?? process.cwd());
  const repoInfo = await getRepoInfo(cwd);
  const repoRoot = repoInfo?.root ?? cwd;

  switch (command) {
    case 'serve':
      await serveCommand(repoRoot, Number(values.port), !values['no-open'], values['bind-host']);
      return;
    case 'run':
      await runCommand(repoRoot, positionals.slice(1).join(' ').trim(), values.workflow, values.model);
      return;
    case 'init':
      initCommand(repoRoot);
      return;
    case 'projects':
      // Registry-only (no server, no HTTP) — see workspace/projects-cli.ts.
      // In single-project mode a listing is a launch-context read: register
      // the boot repo through the normal self-healing path and pin the output
      // to that explicit identity. Mutations are left to their own guards.
      const projectArgs = positionals.slice(1);
      const isList = projectArgs.length === 0 || projectArgs[0] === 'list';
      const bootProjectId = process.env.CEZ_SINGLE_PROJECT === '1' && isList
        ? await initWorkspace(repoRoot)
        : undefined;
      process.exitCode = await runProjectsCommand(projectArgs, { defaultRoot: repoRoot, bootProjectId });
      return;
    case 'server-install':
      await serverCommand('install', repoRoot, values.platform, {
        yes: Boolean(values.yes),
        reconfigure: values.reconfigure,
        reinstall: Boolean(values.reinstall),
        domain: values.domain,
        port: portExplicit ? Number(values.port) : undefined,
        externalProxy: Boolean(values['external-proxy']),
        bindHost: values['bind-host'],
      });
      return;
    case 'server-deploy':
      await serverCommand('deploy', repoRoot, values.platform, {
        yes: Boolean(values.yes),
        domain: values.domain,
      });
      return;
    case 'server-uninstall':
      await serverCommand('uninstall', repoRoot, values.platform, {
        yes: Boolean(values.yes),
        domain: values.domain,
      });
      return;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

// ---- workspace boot ----------------------------------------------------------

/**
 * Boot-time workspace bookkeeping (spec 2026-07-20-multi-project-workspace,
 * "Boot flow"): run pending `~/.cezar` migrations first, then register the
 * boot repo in the per-user project registry. Registration is suppressed for
 * task worktrees and `$HOME` itself (`shouldRegisterProject`) — the process
 * still serves those folders normally. Strictly non-fatal: the zero-config
 * law says a broken or read-only home degrades to a smaller cockpit, never a
 * failed boot, so any workspace error logs one warning and boot continues.
 *
 * Returns the boot project's registry id when registration happened —
 * `serveCommand` plumbs it into the server (`ServerDeps.bootProjectId`) so
 * `/api/projects` and `/api/v1/health` can name the boot project without a
 * lookup. Undefined when registration was suppressed or the workspace is
 * unavailable; the server then derives a fallback on its own.
 */
async function initWorkspace(repoRoot: string): Promise<string | undefined> {
  try {
    await runMigrations({ bootRepoRoot: repoRoot });
    if (await shouldRegisterProject(repoRoot)) return (await registerProject(repoRoot)).id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] workspace registry unavailable (${message}) — continuing without it`);
  }
  return undefined;
}

// ---- serve -----------------------------------------------------------------

async function serveCommand(
  repoRoot: string,
  preferredPort: number,
  openBrowser: boolean,
  bindHost?: string,
): Promise<void> {
  // ---- auth boot gate (D1, spec .ai/specs/2026-08-06-org-team-auth-onboarding.md) -------------
  // FIRST, before `initWorkspace` (writes `~/.cezar`), `reclaimWorktrees` (deletes worktree
  // directories) and `manager.recover()` (re-queues and resumes interrupted runs). "Refuses to
  // boot" has to mean the process did nothing, not that it migrated the home and resumed other
  // people's agent runs and then declined to serve. Everything the gate decides — including the
  // exact refusal wording and the non-zero exit — lives in `./auth-boot-gate.ts` and is covered
  // by `auth-boot-gate.test.ts`; a CLI entry module cannot be imported by a unit test without
  // running the CLI, so an inline gate here was untestable by construction and a mutation
  // disabling it left all five gates green.
  const gate = runAuthBootGate(process.env, bindHost);
  if (!gate.proceed) return;
  let sessionResolver: SessionResolver | undefined;
  let authRoutes: Hono | undefined;
  let onboardingRoutes: Hono | undefined;
  if (gate.provider !== 'none') {
    // Lazy by construction (D1: "unset means zero I/O … never loads them") — this branch only
    // ever runs once CEZ_AUTH names a real provider, loopback or hosted alike (the D1 table's
    // second row: local + oidc/google still requires login). `./auth/session.ts` opens the
    // identity store at module scope, so it must never become a static import at the top of this
    // file: a dynamic `import()` is evaluated when this line runs and not before, which is what
    // keeps the npm default path free of any filesystem work.
    //
    // The specifiers are STRING LITERALS, and that is load-bearing rather than incidental. They
    // were first routed through `const` variables so `npm run typecheck` would not have to
    // resolve modules Phase 2/3 had not written yet — but a variable specifier is opaque to the
    // compiler in BOTH directions, so nothing was left to notice that the paths themselves were
    // wrong. They read `../auth/…`, and this file is `src/index.ts`, so its sibling directory is
    // `./auth/`: `../auth/…` resolves to `packages/cezar/auth/…` from `src` and to the same
    // place from `dist`, a directory that has never existed in either. Every
    // `CEZ_AUTH=oidc|google` boot therefore died with ERR_MODULE_NOT_FOUND — with all five gates
    // green, because no gate can check a path the type-checker was deliberately prevented from
    // reading. Phase 2/3 has landed and both modules exist, so as literals they are now verified
    // on every typecheck, and `rewriteRelativeImportExtensions` rewrites the `.ts` to `.js` at
    // compile time instead of through the emitted runtime helper. Do not reintroduce the
    // indirection to silence a resolution error: an unresolvable specifier here means the module
    // is genuinely missing from the build, which is the thing worth failing on.
    const [sessionMod, routesMod, onboardingMod, claimMod, identityMod, pathsMod] = await Promise.all([
      import('./auth/session.ts'),
      import('./auth/routes.ts'),
      // D8 onboarding (phase 4/5) — same "string literal, never a variable specifier" discipline
      // as the two imports above and for the identical reason (see the paragraph this comment
      // continues): a variable specifier is opaque to `npm run typecheck` in both directions, so
      // a wrong path here would only ever be caught at runtime, by a boot that never happens on
      // the npm-default `CEZ_AUTH` unset path.
      import('./auth/onboarding-routes.ts'),
      import('./auth/bootstrap-claim.ts'),
      import('./auth/identity-store.ts'),
      // `./paths.ts` is reached the same dynamic way it already is further down this file
      // (`instanceSlug`/`DEFAULT_SERVER_INSTANCE`), rather than becoming this module's first
      // static import of it — the CLI entry's own module graph is what the auth-off load trace
      // measures, and there is no reason for this branch to widen it.
      import('./paths.ts'),
    ]);
    sessionResolver = sessionMod.sessionResolver;
    authRoutes = routesMod.authRoutes;
    onboardingRoutes = onboardingMod.onboardingRoutes;
    // The bootstrap code (`./auth/bootstrap-claim.ts`, ADDED 2026-08-07) is only useful if the
    // operator can see it, and it is only *relevant* while the deployment has no org — so the
    // banner is printed here, next to D1's own boot messages, and suppressed once onboarding has
    // happened. Same ESM module instance the onboarding route checks against (module cache), never
    // a second resolution that would mint a second code. Best-effort: a store that cannot be read
    // must not stop the server from booting, and an unreadable identity store reads as "no org"
    // anyway (`readSnapshot` degrades to empty), so the banner errs towards being printed.
    let hasOrg = false;
    try {
      hasOrg = identityMod.IdentityStore.open(pathsMod.identityDir()).listOrgs().length > 0;
    } catch {
      // unreadable identity home — treat as un-onboarded and print the code
    }
    const banner = claimMod.bootstrapClaimBanner(claimMod.bootstrapClaim, hasOrg);
    if (banner) console.log(banner);
  }

  const bootProjectId = await initWorkspace(repoRoot);
  // ONE workspace semaphore for the whole process (spec 2026-07-20, step 2.5):
  // the boot manager and every lazily-built project context count their runs
  // against the same `resources.maxParallel`. The boot refresh() below is the
  // cache hook's first call; PUT /api/workspace/config (step 2.7) re-fires it.
  const semaphore = new WorkspaceSemaphore();
  await semaphore.refresh();
  // keepLive + recover() (#367): runs that were queued/running/waiting when
  // the previous process exited are re-queued or resumed instead of failed.
  const store = openStore(repoRoot, { keepLive: true });
  const manager = new RunManager(store, repoRoot, { semaphore });
  const providerAuth = new ProviderAuthService();
  const workspaceEvents = new WorkspaceEventBus();
  const providerRuntimeAuth = new ProviderRuntimeAuthObserver(providerAuth, (status) => {
    workspaceEvents.emit('provider-status', status);
  });
  const version = readOwnVersion();

  const checks = await detectEnvironment();
  const repo = await getRepoInfo(repoRoot);

  // Startup reconcile (spec 006): sweep worktrees whose run no longer exists.
  if (repo) {
    const orphans = await pruneOrphans(repoRoot, new Set(store.listRuns().map((r) => r.id))).catch(
      () => [] as string[],
    );
    if (orphans.length > 0) {
      console.log(`  cleaned ${orphans.length} orphaned worktree(s): ${orphans.map((id) => id.slice(0, 8)).join(', ')}`);
    }
    // Count-based worktree retention (#483): reclaim finished worktrees beyond
    // the keep-limit (directory only — `cez/<id8>` branch kept, so recoverable).
    // Best-effort; never blocks boot.
    const keep = await resolveWorktreeRetention(repoRoot).catch(() => DEFAULT_WORKTREE_RETENTION);
    const reclaimed = await reclaimWorktrees(repoRoot, store, keep).catch(() => [] as string[]);
    if (reclaimed.length > 0) {
      console.log(`  reclaimed ${reclaimed.length} old worktree(s), branch kept: ${reclaimed.map((id) => id.slice(0, 8)).join(', ')}`);
    }
  }

  const recovered = store
    .listRuns()
    .filter((r) => ['queued', 'waiting', 'running'].includes(r.status)).length;
  await recoverWithProviderRuntimeAuthObservation(
    store,
    () => manager.recover(),
    providerRuntimeAuth,
  );
  if (recovered > 0) console.log(`  recovered ${recovered} run(s) from the previous session`);

  // Update discovery (#368) — fire-and-forget; the banner prints whenever the
  // registry answers and /api/v1/health picks it up for the GUI chip.
  const pkgName = readOwnName();
  const update: { latest?: string } = {};
  void checkForUpdate(pkgName, version).then((latest) => {
    if (!latest) return;
    update.latest = latest;
    console.log(`\n  ⬆ cezar ${latest} is available (running ${version}) — restart with: npx ${pkgName}@latest\n`);
  });

  const port = await pickPort(preferredPort);
  // SECURITY: cezar executes agents. A non-loopback bind exposes that box to
  // whatever can reach the interface, and cezar itself has NO auth — it is only
  // for a deliberate hosted setup where a reverse proxy in front provides TLS +
  // auth (see `server-install --external-proxy`). Say so, loudly, every start.
  if (bindHost && !['127.0.0.1', 'localhost', '::1'].includes(bindHost)) {
    console.log(
      `\n  ⚠ binding ${bindHost}:${port} — cezar has no built-in auth.\n` +
        `    Only do this behind a reverse proxy that enforces authentication,\n` +
        `    and make sure this interface is not reachable from the internet.\n`,
    );
  }

  startServer({
    repoRoot,
    store,
    manager,
    version,
    update,
    bootProjectId,
    semaphore,
    bindHost,
    providerAuth,
    providerRuntimeAuth,
    workspaceEvents,
    sessionResolver,
    authRoutes,
    onboardingRoutes,
  }, port);
  const url = `http://localhost:${port}`;

  console.log(`\n  cezar v${version} — ${repoRoot}`);
  console.log(`  ${repo ? `branch ${repo.branch}` : 'not a git repository (tasks run in place, one at a time; repo view is empty)'}`);
  for (const check of checks) {
    const mark = check.available ? '✓' : '✗';
    const detail = check.available ? (check.version ?? 'ok') : (check.hint ?? 'missing');
    console.log(`  ${mark} ${check.name.padEnd(6)} ${detail}`);
  }
  if (port !== preferredPort) console.log(`  (port ${preferredPort} was busy — using ${port})`);
  console.log(`\n  cockpit → ${url}\n`);
  // Silenced by CEZ_NO_BANNER=1 or by dismissing the cockpit's banner (#391).
  await printSkillsBanner(repoRoot);

  const shutdown = () => {
    store.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Open the browser only once the server actually answers, so the first
  // paint is the cockpit and never a connection error.
  if (openBrowser) {
    const healthy = await waitForHealth(`${url}/api/v1/health`, 5_000);
    if (healthy) openUrl(url);
  }
}

/** First free port starting at `start` (the launch.mjs pattern from janitor). */
async function pickPort(start: number): Promise<number> {
  for (let port = start; port < start + 50; port++) {
    if (await canListen(port)) return port;
  }
  return start; // let the server fail loudly if 50 ports are somehow busy
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once('error', () => resolvePort(false));
    probe.once('listening', () => probe.close(() => resolvePort(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function waitForHealth(healthUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// ---- run (headless) ----------------------------------------------------------

async function runCommand(
  repoRoot: string,
  task: string,
  workflowName: string | undefined,
  model: string | undefined,
): Promise<void> {
  if (!task) {
    console.error('usage: cezar run "<task>" [--workflow name] [--model model]');
    process.exitCode = 1;
    return;
  }
  await initWorkspace(repoRoot);
  const { workflows, issues } = await loadWorkflows(repoRoot);
  for (const issue of issues) console.error(`! skipped ${issue.path}: ${issue.message}`);
  const name = workflowName ?? 'quick-task';
  const workflow = workflows.find((w) => w.name === name);
  if (!workflow) {
    console.error(`unknown workflow: ${name} (available: ${workflows.map((w) => w.name).join(', ')})`);
    process.exitCode = 1;
    return;
  }

  const providerAuth = new ProviderAuthService();
  const requiredProviders = providersRequiredByWorkflow(
    workflow,
    (await loadConfig(repoRoot)).defaultRunner,
  );
  if (requiredProviders.length > 0 && !providerAuthChecksDisabled()) {
    const [discovered, workspace] = await Promise.all([
      providerAuth.status(),
      loadWorkspaceConfig(),
    ]);
    const blocked = unavailableProviderMessage(
      requiredProviders,
      applyProviderEnablement(discovered, workspace.disabledProviders),
    );
    if (blocked) {
      console.error(blocked);
      process.exitCode = 1;
      return;
    }
  }

  const store = openStore(repoRoot);
  // Headless tasks still appear in the cockpit later, so persist the same
  // task-local recovery event when a credential expires after the preflight.
  const providerRuntimeAuth = new ProviderRuntimeAuthObserver(providerAuth, () => {});
  providerRuntimeAuth.watch(store);
  // Headless runs enforce the same workspace-level cap/memory limit (step
  // 2.5) — one refreshed semaphore, even with just one manager in play.
  const semaphore = new WorkspaceSemaphore();
  await semaphore.refresh();
  const manager = new RunManager(store, repoRoot, { semaphore });

  store.on('event', ({ event }) => {
    switch (event.type) {
      case 'text':
        console.log(String(event.text ?? ''));
        break;
      case 'tool-call':
        console.log(`  → ${String(event.tool)} ${previewJson(event.input)}`);
        break;
      case 'tool-result':
        console.log(`  ← ${firstLine(String(event.result ?? ''))}`);
        break;
      case 'check-output':
        console.log(String(event.text ?? ''));
        break;
      case 'step-start':
        console.log(`\n── step: ${String(event.name)} ${Number(event.iteration) > 1 ? `(attempt ${event.iteration})` : ''}`);
        break;
      case 'note':
      case 'lifecycle':
        console.log(`  · ${String(event.message ?? '')}`);
        break;
      case 'error':
        console.error(`  ✗ ${String(event.message ?? '')}`);
        break;
    }
  });

  const run = manager.startRun(workflow, { task, model });
  // `review` is terminal here too (spec 009) — headless runs must not hang on
  // the GUI's review gate; the diff waits on the task branch/cockpit instead.
  const final = await new Promise<string>((resolveStatus) => {
    store.on('run', (r) => {
      if (r.id === run.id && ['done', 'review', 'failed', 'cancelled'].includes(r.status)) resolveStatus(r.status);
    });
  });
  store.flush();
  const record = store.getRun(run.id);
  if (final === 'review') {
    console.log(`\n  changes ready for review on branch ${record?.branch ?? '?'} — inspect them in the cockpit: npx cezar`);
  }
  console.log(`\nrun ${final} — ${record?.tokensUsed ?? 0} tokens — details in the cockpit: npx cezar`);
  process.exitCode = final === 'done' || final === 'review' ? 0 : 1;
}

// ---- server-install / server-uninstall --------------------------------------
// The whole server-install module (and its @clack/prompts dependency) is loaded
// lazily here so it never enters the `serve`/`run`/`init` import graph — the
// runtime server stack stays tiny (AGENTS.md).

/**
 * Prepend the operator's login-shell PATH to this process's PATH so tool
 * detection and installs find things in ~/.local/bin, nvm, and other
 * profile-added dirs even when the installer was launched non-interactively.
 * Best-effort: a shell that errors or hangs leaves PATH untouched.
 */
function augmentPathFromLoginShell(): void {
  try {
    const out = execFileSync('bash', ['-lc', 'printf %s "$PATH"'], { timeout: 5000, encoding: 'utf8' });
    const loginPath = out.split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
    if (!loginPath) return;
    const seen = new Set<string>();
    process.env.PATH = [...loginPath.split(':'), ...(process.env.PATH ?? '').split(':')]
      .filter((d) => d && !seen.has(d) && seen.add(d))
      .join(':');
  } catch {
    // best effort — keep the existing PATH
  }
}

async function serverCommand(
  mode: 'install' | 'uninstall' | 'deploy',
  repoRoot: string,
  platform: string | undefined,
  flags: {
    yes: boolean;
    reconfigure?: string;
    reinstall?: boolean;
    domain?: string;
    port?: number;
    externalProxy?: boolean;
    bindHost?: string;
  },
): Promise<void> {
  // Detection (claude/gh/codex) and tool installs resolve executables off the
  // process PATH. When the installer is launched from a non-login shell (an
  // `ssh host cmd`, a script, a fresh service context), ~/.local/bin and nvm's
  // bin are absent, so tools the user actually has look "not installed". Merge
  // the login shell's PATH first so we see exactly what the operator sees.
  augmentPathFromLoginShell();

  const { getStrategy, availablePlatformIds } = await import('./server-install/strategies.ts');
  const { runInstall, runUninstall, runDeploy } = await import('./server-install/engine.ts');
  const { loadServerState, listServerInstances, nextFreeInstancePort } = await import('./server-install/state.ts');
  const { instanceSlug, DEFAULT_SERVER_INSTANCE } = await import('./paths.ts');

  const ids = availablePlatformIds();

  // Resolve the instance from --domain (domain-keyed multi-instance). An
  // interactive install with an existing cockpit and no --domain also offers to
  // stand up a second instance — the exact "it asks me to reinstall" case.
  let domain = (flags.domain ?? '').trim() || undefined;
  if (mode === 'install' && !domain && !flags.yes && process.stdin.isTTY && loadServerState(DEFAULT_SERVER_INSTANCE).installed) {
    try {
      const { createClackUi } = await import('./server-install/ui.ts');
      const answer = await createClackUi().text({
        message:
          'This host already runs a cezar cockpit. Enter a NEW domain to host a second, independent instance — ' +
          'or leave blank to manage/redeploy the existing one.',
        placeholder: 'shop.example.com',
      });
      if (typeof answer === 'string' && answer.trim()) domain = answer.trim();
    } catch {
      // any prompt failure → fall back to managing the default instance
    }
  }
  const instance = domain ? instanceSlug(domain) : DEFAULT_SERVER_INSTANCE;

  // Uninstall and deploy can read the platform from THIS instance's record when omitted.
  let chosen = platform;
  if ((mode === 'uninstall' || mode === 'deploy') && !chosen) {
    chosen = loadServerState(instance).platform;
  }
  if (!chosen) {
    console.error(`--platform is required. Valid platforms: ${ids.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const strategy = getStrategy(chosen);
  if (!strategy) {
    console.error(`unknown platform: ${chosen} (valid: ${ids.join(', ')})`);
    process.exitCode = 1;
    return;
  }
  // Domain-keyed multi-instance is an ubuntu-vps feature (shared nginx front).
  if (instance !== DEFAULT_SERVER_INSTANCE && chosen !== 'ubuntu-vps') {
    console.error(`--domain (multi-instance) is only supported on ubuntu-vps, not ${chosen}.`);
    process.exitCode = 1;
    return;
  }

  // Port: an explicit --port always wins; a brand-new named instance otherwise
  // auto-picks the next free loopback port so it can't collide with the first.
  let port = flags.port;
  if (mode === 'install' && instance !== DEFAULT_SERVER_INSTANCE && port === undefined) {
    const known = listServerInstances().some((i) => i.instance === instance);
    if (!known) {
      port = nextFreeInstancePort();
      console.log(`\n  New instance "${instance}" (${domain}) → loopback port ${port} (override with --port).`);
    }
  }

  const runOpts = {
    dryRun: process.env.CEZ_DRY_RUN === '1',
    assumeYes: flags.yes,
    reconfigure: new Set((flags.reconfigure ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    reinstall: Boolean(flags.reinstall),
    repoRoot,
    now: new Date().toISOString(),
    instance,
    domain,
    port,
    // Only an install decides proxy mode; deploy/uninstall read it back from
    // the recorded state. Preserve an omitted flag as `undefined`: a flag-less
    // resume must keep an external-proxy install external instead of flipping
    // it back to cezar-managed nginx/SSL.
    ...(mode === 'install'
      ? { externalProxy: flags.externalProxy || undefined, bindHost: flags.bindHost }
      : {}),
  };

  // e.g. "ubuntu-vps" or "ubuntu-vps, shop.example.com" for a named instance.
  const label = instance === DEFAULT_SERVER_INSTANCE ? chosen : `${chosen}, ${domain}`;
  const domainFlag = instance === DEFAULT_SERVER_INSTANCE ? '' : ` --domain ${domain}`;

  try {
    const result =
      mode === 'install'
        ? await runInstall(strategy, runOpts)
        : mode === 'deploy'
          ? await runDeploy(strategy, runOpts)
          : await runUninstall(strategy, runOpts);
    if (mode === 'install' && result.status === 'complete') {
      console.log(`\n  cezar server-install (${label}) complete.`);
      console.log(`  Redeploy a new version any time with: cezar server-deploy --platform ${chosen}${domainFlag}\n`);
    } else if (mode === 'deploy' && result.status === 'complete') {
      console.log(`\n  cezar server-deploy (${label}) complete — the service was reloaded and verified.\n`);
    } else if (mode === 'uninstall' && result.status === 'complete') {
      console.log(`\n  cezar server-uninstall (${label}) complete — the changes it made were reversed.\n`);
    }
    // complete + cancelled (resumable) exit 0; failed exits 1.
    process.exitCode = result.status === 'failed' ? 1 : 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

// ---- init --------------------------------------------------------------------

function initCommand(repoRoot: string): void {
  const workflowsDir = join(repoRoot, '.ai/cezar', 'workflows');
  const skillsDir = join(repoRoot, '.ai/cezar', 'skills');
  mkdirSync(workflowsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  const examples: Array<{ path: string; content: string }> = [
    {
      path: join(workflowsDir, 'fix-and-verify.yaml'),
      content: `name: fix-and-verify
description: Implement the task, then run your test command; on failure the agent retries with the failing output.
steps:
  - id: implement
    name: Implement
    prompt: "{{task}}"
  - id: verify
    name: Verify
    command: "echo 'replace me with: npm test / yarn test / pytest'"
    onFail:
      retry: implement
      max: 2
`,
    },
    {
      path: join(skillsDir, 'project-conventions.md'),
      content: `---
name: project-conventions
description: House rules the agent should follow in this repo.
---

# Project conventions

- Describe your stack, style and testing conventions here.
- Reference this skill from a workflow step via \`skill: project-conventions\`.
`,
    },
  ];

  for (const example of examples) {
    if (existsSync(example.path)) {
      console.log(`  = ${example.path} (exists, left untouched)`);
    } else {
      writeFileSync(example.path, example.content, 'utf8');
      console.log(`  + ${example.path}`);
    }
  }
  ensureDataGitignore(repoRoot);
  console.log('\nDone. Start the cockpit with: npx cezar');
}

// ---- helpers -----------------------------------------------------------------

function openStore(repoRoot: string, opts?: { keepLive?: boolean }): RunStore {
  const dataDir = join(repoRoot, '.ai/cezar');
  const store = RunStore.open(dataDir, opts);
  ensureDataGitignore(repoRoot);
  return store;
}

/** Keep run data out of the user's repo history; workflows/skills stay committable. */
function ensureDataGitignore(repoRoot: string): void {
  const path = join(repoRoot, '.ai/cezar', '.gitignore');
  const wanted = [
    'runs.json',
    'runs.json.tmp',
    'runs/',
    'worktrees/',
    'todos.json',
    'todos.json.tmp',
    'launch-key',
    'automations.json',
    'automations.json.tmp',
    'automation-state.json',
    'automation-state.json.tmp',
    'automation-receipts.ndjson',
    'automation-receipts.ndjson.tmp',
    'automation-log.ndjson',
    'automation-log.ndjson.tmp',
    'automation-poll.lock',
    // Central-hub scaffold (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`). Knowledge
    // documents under `knowledge/` are deliberately NOT listed here — they are committable
    // content (D16, dispatch contract clause 8), not run state.
    'knowledge-index/', // F1 — the single derived-artifact dir: catalog cache, manifest, optional
    // embeddings blob. See `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` Q6/"Catalog cache".
    'sources.json', // F2 — connection definitions + tombstones (mirrors automations.json's own entry)
    'sources.json.tmp',
    'source-state.json',
    'source-state.json.tmp',
    'source-log.ndjson',
    'source-comments.ndjson',
    'sources-poll.lock',
    'sources/', // the mirror root itself, including its un-indexed conflicts/ and deleted/ subdirs
  ];
  try {
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const lines = current.split('\n');
    const missing = wanted.filter((w) => !lines.includes(w));
    if (missing.length > 0) {
      const glue = current && !current.endsWith('\n') ? '\n' : '';
      writeFileSync(path, `${current}${glue}${missing.join('\n')}\n`, 'utf8');
    }
  } catch {
    // non-fatal
  }
}

/** Own package name — for the npm-registry update check (#368). */
function readOwnName(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { name?: string };
    return pkg.name ?? '@open-mercato/cezar';
  } catch {
    return '@open-mercato/cezar';
  }
}

function readOwnVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function openUrl(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    // A missing opener (e.g. no `xdg-open` on a headless Linux VPS) surfaces
    // asynchronously as an 'error' event, NOT a synchronous throw — without a
    // listener Node promotes it to an unhandled error and hard-crashes the whole
    // process, even though the cockpit is already serving. Swallow it: the URL is
    // printed above, so a browser-less host just doesn't auto-open.
    child.on('error', () => {});
    child.unref();
  } catch {
    // the printed URL is enough
  }
}

function previewJson(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? `${s.slice(0, 117)}…` : s;
  } catch {
    return '';
  }
}

function firstLine(s: string): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
