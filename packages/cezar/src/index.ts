#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withOptionalFlagValues } from './argv.ts';
import { detectEnvironment } from './core/backend-detect.ts';
import { runBrokerCommand } from './core/run-broker-cli.ts';
import { migrateReleasesCommand, releaseDeployCommand } from './server-install/release-cli.ts';
import { consumeSocketActivation } from './server/socket-activation.ts';
import { DrainController, resolveDrainMs } from './server/drain.ts';
import {
  ProviderAuthService,
  providerAuthChecksDisabled,
} from './core/provider-auth.ts';
import { applyProviderEnablement } from './core/provider-availability.ts';
import { canonicalPath, pruneOrphans } from './git-worktree.ts';
import { getRepoInfo } from './server/git.ts';
import { DEFAULT_WORKTREE_RETENTION, loadConfig, resolveWorktreeRetention } from './config.ts';
import { reclaimWorktrees } from './runs/retention.ts';
import { RunStore } from './runs/store.ts';
import { findForeignWorkspaceOwner, loadForeignWorkspaceRunSources } from './runs/worktree-ownership.ts';
import { runRunStatsCommand } from './runs/stats-cli.ts';
import { runRunsCommand } from './runs/reopen-cli.ts';
import { RunManager } from './workflows/run.ts';
import { loadWorkflows } from './workflows/load.ts';
import { DEFAULT_WORKFLOW_NAME } from './workflows/types.ts';
import { startServer, WorkspaceEventBus, type SessionResolver } from './server/server.ts';
import { runAuthBootGate } from './auth-boot-gate.ts';
import { buildLocalModeRoutes } from './local-mode-boot.ts';
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
import { ensureBootRepo, holdsOnlyRuntimeState } from './workspace/boot-repo.ts';
import { loadWorkspaceConfig } from './workspace/config.ts';
import { runMigrations } from './workspace/migrations.ts';
import { shouldRegisterProject } from './workspace/projects.ts';
import { runProjectsCommand } from './workspace/projects-cli.ts';
import { runBackupCommand } from './backup/cli.ts';
import { runKnowledgeCommand } from './knowledge/cli.ts';
import { runTodoCommand } from './todo-cli.ts';
import { localCliAuthor } from './runs/task-author.ts';
import { WorkspaceSemaphore } from './workspace/semaphore.ts';
// FIX 6 (D13 repair pass 1): the production `listRegisteredProjectRoots` supplier lives in
// `./registered-project-roots.ts` for the same reason `./auth-boot-gate.ts` was extracted from this
// file — see that module's own doc comment. `registerAndAdoptProject` (FIX A1/A3/A4, D13 repair
// round 2) is the registration seam `initWorkspace` below and `cezar projects add`
// (`workspace/projects-cli.ts`) both call instead of `registerProject` directly — see that
// function's own doc comment for why. (`listRegisteredProjectRoots` itself is no longer imported
// HERE — FIX B1 moved its one caller, the local-mode wiring, into `./local-mode-boot.ts`, which
// imports it directly.)
import { registerAndAdoptProject, suppressBootRegistration } from './registered-project-roots.ts';
// The cluster CLI (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`). Every one of these is a
// filesystem/HTTP call against `~/.cezar/cluster` — no server, no auth wall — which is what lets
// `cez cluster active` be a read an agent can make from inside a run (D19 rung 4).
import { CLUSTER_PROTOCOL, type ClusterCorpusSubmitResponse } from '@loki-labs/better-cezar-contract';
import { createEnrollmentCode, joinCluster, leaveCluster } from './cluster/enrollment.ts';
import { loadNodeIdentity } from './cluster/node-identity.ts';
import { signedNodeRequestHeaders } from './cluster/node-auth.ts';
import { disableNode, readPeers } from './cluster/peers.ts';
import { createHttpReconcileTransport } from './cluster/reconcile-transport.ts';
import { reconcileAll } from './cluster/reconcile.ts';
import { readRemoteRuns } from './cluster/run-projection.ts';
import { clusterEnabled } from './server/capabilities.ts';
import { clusterActiveRunsFrom } from './server/cluster-routes.ts';
// Aliased: `serverInstallCommand` below already destructures its own `loadServerState` out of a
// dynamic import, and two bindings of one name in one file is a shadow waiting to be misread.
import { loadServerState as loadInstalledServerState } from './server-install/state.ts';

const HELP = `cezar — local cockpit for AI agent tasks in your repo

Usage:
  cezar                     start the cockpit (server + GUI) for the current repo
  cezar run "<task>"        run a task headless in the terminal
  cezar run stats <runId>   tool economy for a finished run: calls, model round
                            trips, batch factor (calls/round-trip), model vs
                            tool time, sub-agent calls — per step [--json]
  cezar runs reopen         reopen finished tasks and ask them something:
                            --all-done [--project <id|path|all>] [--prompt "..."]
                            [--dry-run] [--limit <n>] [--exclude <runId>] — the
                            running cockpit continues each one (run "cezar runs"
                            for the full usage)
  cezar init                scaffold .ai/cezar/ (example workflow + skill)
  cezar projects            list the projects this cockpit serves
                            (also: projects add [<dir>] · projects remove <id>)
  cezar kb                  knowledge base (CEZ_KB=1): search "<query>" · show
                            <id> · roots · reindex · write · proposals — the
                            same commands the agent system prompt tells a run
                            to use (run "cezar kb" for the full usage). On a
                            CLUSTER SPOKE, "kb submit <path>" forwards a write to
                            the hub — the only write direction the mirror has

  cezar todo                file (and optionally auto-start) a workspace task:
                            add "<summary>" [--project <id|path>] [--start] ·
                            list — the same command the agent system prompt
                            tells a run to use (run "cezar todo" for the full
                            usage)
  cezar cluster             multi-node cluster (CEZ_CLUSTER=1): enroll [--name N]
                            [--ttl S] · join <code> [--name N] · active [--json] ·
                            reconcile [--apply] [--peer <nodeId>] (dry run by
                            default) · revoke <nodeId> | --self (run
                            "cezar cluster" for the full usage)
  cezar backup              encrypted platform backup (CEZ_BACKUP=1): status ·
                            run · snapshots · verify · gc · restore [--snapshot
                            <id>] [--force]
  cezar server-install      interactive wizard to host cezar on a server
  cezar server-deploy       redeploy a new version (reload the service) + verify
                              --strategy=blue-green   stage a release, smoke-boot it, flip, probe,
                                                      auto-roll-back (spec 2026-08-19)
                              --rollback[=<id>]       flip back to the previous release + restart
                              --follow                tail the deploy running in its own unit
                              --dry-run               print the plan, change nothing
                                                      (also: CEZ_DRY_RUN=1)
  cezar server-migrate-releases
                            one-shot: /opt/cezar → release symlink + socket/slice units (--yes to apply)
  cezar server-uninstall    reverse a server-install
  cezar supervisor          run the auth-terminating supervisor process (D4/D10 —
                            per-org process isolation; see the org-team-auth spec).
                            Requires CEZ_AUTH=oidc|google; not the everyday command.

Options:
  -p, --port <n>              cockpit port (default 4321; server-install: this
                              instance's loopback port — auto-picked per domain)
      --repo <dir>            repo to operate on (default: cwd)
      --workflow <name>       workflow for \`run\` (default: spec-to-deploy)
      --model <model>         model override for \`run\`
      --no-open               don't open the browser
      --platform <id>         server-install target (ubuntu-vps | macosx-ngrok | hetzner)
      --domain <host>         server-install (ubuntu-vps/hetzner): host a SECOND,
                              independent cockpit for this domain (own nginx site +
                              service + port). A new domain never resumes/clobbers the
                              first install. hetzner: the supervisor's login host, or
                              (with --org-slug) one org's own subdomain of it.
      --org-slug <slug>       server-install --platform hetzner: provision this ORG's
                              own unix user + CEZ_HOME + systemd unit + nginx vhost
                              (D4/D10 per-org process isolation) instead of the
                              deployment's one supervisor. Requires the supervisor to
                              already be provisioned on this host — see docs/server-install/hetzner.md.
      --role worker           server-install --platform hetzner: provision this box as a cluster
                              spoke (D17) instead of a supervisor/org cockpit — dials OUT to the
                              hub, no --domain/nginx/TLS. Requires --join.
      --join <code>           server-install --platform hetzner --role worker: the hub-minted,
                              single-use enrollment code from the cockpit's "Add node" (D17).
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
      --port-strict           serve: refuse to boot rather than silently drift to the
                              next free port when --port/-p is already in use (same as
                              CEZ_PORT_STRICT=1). A hosted org's nginx proxy_pass is a
                              static port baked in at provisioning time — server-install
                              --platform hetzner sets this on every org's unit (D10).
  -h, --help                  show this help

Zero config: uses your logged-in \`claude\` CLI (and \`gh\` for GitHub bits).
Skills live in .ai/skills/, .ai/cezar/skills/ and any team skills repo
you list under skillsRepos in .ai/cezar/config.json (none by default);
workflows in .ai/cezar/workflows/.`;

async function main(): Promise<void> {
  // `backup` owns its own flag namespace (`--snapshot`, `--force`), so route it straight from raw
  // argv BEFORE the strict top-level `parseArgs` below — which, being strict, rejects those flags
  // as unknown options and never reaches the command switch. Backup is workspace/registry-scoped
  // (the home plus every registered project), so `--repo` is not one of its concerns; like
  // `projects` it resolves its root from cwd. `runBackupCommand` parses `--snapshot`/`--force`
  // itself and gates on `CEZ_BACKUP=1` internally.
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'backup') {
    const backupCwd = resolve(process.cwd());
    const backupRepoRoot = (await getRepoInfo(backupCwd))?.root ?? backupCwd;
    process.exitCode = await runBackupCommand(rawArgs.slice(1), { defaultRoot: backupRepoRoot });
    return;
  }

  // `kb` is routed here for exactly the reason `backup` above is: it owns its own flag namespace
  // (`--json`, `--type`, `--tag`, `--status`, `--root`, `--limit`, `--offset`, `--content`), and
  // the strict `parseArgs` below rejects every one of them as an unknown option and throws long
  // before the command switch. Registry-only (no server, no HTTP), root resolved from cwd, gated
  // on CEZ_KB=1 inside `runKnowledgeCommand` so it stays inert with the flag off.
  //
  // **Wired 2026-08-19 (`.ai/specs/2026-08-19-tasks-page-and-start-grounding.md`, D4). It never
  // was before.** `runKnowledgeCommand` shipped complete and covered by `knowledge/cli.test.ts`,
  // imported by nothing but that test — so `cez kb search`, the exact command
  // `knowledgeSystemPrompt` instructs EVERY agent run to use, answered `unknown command: kb` on
  // every install since the knowledge base existed. A green unit suite over a function no entry
  // point calls says nothing about whether the feature is REACHABLE; these lines are what make it
  // so, and `knowledge/cli-wiring.test.ts` is what keeps them.
  // `kb submit` is intercepted BEFORE the `kb` branch below, and the order is the whole point:
  // `runKnowledgeCommand` rejects an unknown subcommand, so appending this to the switch inside
  // `knowledge/cli.ts` would be the only other option — and that file belongs to the knowledge
  // base, not to the cluster. A spoke's mirror is READ-ONLY (`sources/cezar-hub/provider.ts`), so
  // this is the affordance that replaces the prohibition: D8's rule only forbids, and a rule that
  // forbids without offering the path it replaces gets routed around.
  if (rawArgs[0] === 'kb' && rawArgs[1] === 'submit') {
    process.exitCode = await runKbSubmitCommand(rawArgs.slice(2));
    return;
  }

  if (rawArgs[0] === 'kb') {
    const kbCwd = resolve(process.cwd());
    const kbRepoRoot = (await getRepoInfo(kbCwd))?.root ?? kbCwd;
    process.exitCode = await runKnowledgeCommand(rawArgs.slice(1), { repoRoot: kbRepoRoot });
    return;
  }

  // `cluster` is routed here for exactly the reason `kb`/`todo`/`runs` above are: it owns its own
  // flag namespace (`--name`, `--ttl`, `--dry-run`, `--peer`, `--self`, `--json`), every one of
  // which the strict `parseArgs` below rejects as an unknown option long before the command switch
  // — and `cluster` is not a `case` there at all, so dispatching from inside the switch would
  // answer `unknown command: cluster`. Workspace-scoped (`~/.cezar/cluster`), so `--repo` is not
  // one of its concerns; gated on `CEZ_CLUSTER=1` inside `runClusterCommand` so it stays inert
  // with the flag off.
  if (rawArgs[0] === 'cluster') {
    process.exitCode = await runClusterCommand(rawArgs.slice(1));
    return;
  }

  // `todo` is routed here for the same reason `kb` above is: it owns its own flag namespace
  // (`--project`, `--context`, `--acceptance` (repeatable), `--priority`, `--skill`, `--spec`,
  // `--start`, `--json`), which the strict `parseArgs` below would reject as unknown options
  // before the command switch is ever reached. Filesystem-only (no HTTP, no auth wall — see
  // `todo-cli.ts`'s own doc comment), root resolved from cwd exactly like `kb`.
  //
  // `.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`, Phase 1: this is what lets a
  // RUNNING task file another workspace task — `cezar todo add "…" [--start]` — the same way
  // `cezar kb write` lets it write a knowledge document, and it is documented next to `cezar kb`
  // in the agent system prompt (`handoff.ts`).
  if (rawArgs[0] === 'todo') {
    const todoCwd = resolve(process.cwd());
    const todoRepoRoot = (await getRepoInfo(todoCwd))?.root ?? todoCwd;
    process.exitCode = await runTodoCommand(rawArgs.slice(1), { repoRoot: todoRepoRoot });
    return;
  }

  // `run stats` is routed here for BOTH reasons `kb` and `todo` above are, plus one of its own:
  // `case 'run'` joins every positional into the task text, so `cez run stats <id>` would happily
  // START A RUN titled "stats <id>" rather than metering one — a wrong-and-expensive default, not
  // a missing feature. It also owns `--json`, which the strict `parseArgs` below rejects.
  // Read-only and filesystem-only (spec `.ai/specs/2026-08-20-agent-round-trip-batching-and-
  // fanout.md`, Phase 1: the meter ships before the optimisations it exists to judge).
  if (rawArgs[0] === 'run' && rawArgs[1] === 'stats') {
    const statsCwd = resolve(process.cwd());
    const statsRepoRoot = (await getRepoInfo(statsCwd))?.root ?? statsCwd;
    process.exitCode = await runRunStatsCommand(rawArgs.slice(2), { repoRoot: statsRepoRoot });
    return;
  }

  // `runs` is routed here for every reason `kb`/`todo`/`run stats` above are, and for one more of
  // its own. It owns `--all-done`, `--dry-run`, `--limit`, `--prompt` and a repeatable
  // `--exclude`, all of which the strict `parseArgs` below rejects as unknown options
  // long before the command switch — and `runs` is not a `case` there at all, so dispatching it
  // from inside the switch would answer `unknown command: runs`. Filesystem-only (no HTTP, no
  // auth wall — see `runs/reopen-cli.ts`'s own doc comment), root resolved from cwd exactly like
  // `kb` and `todo`.
  //
  // `cez run reopen …` is accepted as an alias for `cez runs reopen …`: the singular is the
  // spelling `run stats` already teaches, and without this it would START A RUN titled
  // "reopen …" — the same wrong-and-expensive default `run stats` is routed early to avoid.
  if (rawArgs[0] === 'runs' || (rawArgs[0] === 'run' && rawArgs[1] === 'reopen')) {
    // Both spellings drop exactly one leading token: `runs reopen …` → `reopen …`, and
    // `run reopen …` → `reopen …`.
    const runsArgs = rawArgs.slice(1);
    const runsCwd = resolve(process.cwd());
    const runsRepoRoot = (await getRepoInfo(runsCwd))?.root ?? runsCwd;
    process.exitCode = await runRunsCommand(runsArgs, { repoRoot: runsRepoRoot });
    return;
  }

  // `run-broker` is routed here for exactly the reason `kb`/`todo`/`runs` above are, and it is the
  // one command where getting this wrong is INVISIBLE. It owns `--spool`, `--run`, `--step`,
  // `--backend` and `--cwd`, every one of which the strict `parseArgs` below rejects as an unknown
  // option — so the `case 'run-broker'` in the switch was unreachable, and the binary answered
  // `Unknown option '--spool'` and exited 0.
  //
  // Why that was silent rather than loud: the run manager spawns this `detached` with
  // `stdio: 'ignore'` (it must — the whole point of P4 is that no pipe ties the agent to the
  // server), so the broker's stderr went nowhere, no spool was ever created, and the parent sat
  // waiting for a spool that would never appear. `brokerAvailable()` is true in any BUILT tree, so
  // this was every run on a production install hanging at its first agent step, while the source
  // tree the tests run in took the in-process path and stayed green. Caught by the packaged-CLI
  // E2E (`test/e2e/package-cli.test.ts`), which is the only gate that exercises `dist`.
  //
  // `rawArgs.slice(1)` rather than `process.argv.slice(3)`: same tokens, but expressed against the
  // same array every neighbour above uses instead of re-deriving the offset.
  if (rawArgs[0] === 'run-broker') {
    process.exitCode = await runBrokerCommand(rawArgs.slice(1));
    return;
  }

  const { values, positionals } = parseArgs({
    args: withOptionalFlagValues(rawArgs),
    options: {
      port: { type: 'string', short: 'p', default: '4321' },
      repo: { type: 'string' },
      workflow: { type: 'string' },
      model: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      platform: { type: 'string' },
      domain: { type: 'string' },
      'org-slug': { type: 'string' },
      role: { type: 'string' },
      join: { type: 'string' },
      'bind-host': { type: 'string' },
      'external-proxy': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      reconfigure: { type: 'string' },
      reinstall: { type: 'boolean', default: false },
      'port-strict': { type: 'boolean', default: false },
      // Non-disruptive deploy (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
      // `--strategy` defaults to `restart` — today's behaviour — so an existing `server-deploy`
      // invocation on any platform does exactly what it did before this shipped.
      strategy: { type: 'string' },
      rollback: { type: 'string' },
      follow: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      source: { type: 'string' },
      'link-path': { type: 'string' },
      'releases-dir': { type: 'string' },
      'release-id': { type: 'string' },
      unit: { type: 'string' },
      sha: { type: 'string' },
      note: { type: 'string' },
      'allow-stale-artifact': { type: 'boolean', default: false },
      'refuse-dirty': { type: 'boolean', default: false },
      'allow-unrelated': { type: 'boolean', default: false },
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
      await serveCommand(
        repoRoot,
        Number(values.port),
        !values['no-open'],
        values['bind-host'],
        Boolean(values['port-strict']) || process.env.CEZ_PORT_STRICT === '1',
      );
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
    case 'backup':
      // Registry-only (no server, no HTTP) — the engine reads config + provider and works directly
      // against the filesystem. Gated on CEZ_BACKUP=1 inside `runBackupCommand` (prints the enable
      // hint and returns non-zero when the flag is off), so it stays inert like every other surface.
      process.exitCode = await runBackupCommand(positionals.slice(1), { defaultRoot: repoRoot });
      return;
    case 'server-install':
      await serverCommand('install', repoRoot, values.platform, {
        yes: Boolean(values.yes),
        reconfigure: values.reconfigure,
        reinstall: Boolean(values.reinstall),
        domain: values.domain,
        orgSlug: values['org-slug'],
        // Only 'worker' is a recognised role (hetzner.ts#isWorkerMode). An unrecognised --role
        // value is silently treated as absent rather than rejected here: preflight already fails
        // worker mode without --join, and a bogus role that falls through to supervisor/org mode
        // fails on ITS own pre-existing checks (e.g. missing --domain) — no second rejection point
        // to keep in sync with preflight's.
        role: values.role === 'worker' ? 'worker' : undefined,
        clusterJoinToken: values.join,
        port: portExplicit ? Number(values.port) : undefined,
        externalProxy: Boolean(values['external-proxy']),
        bindHost: values['bind-host'],
      });
      return;
    case 'server-deploy': {
      // Two deploys behind one command, and the split is deliberate. `restart` is what every
      // platform has always done — reload the unit, re-verify — and stays the default so no
      // existing invocation changes meaning. `blue-green` is P1/P2/P5: stage a release, prove it
      // boots before it is live, flip a symlink, restart, probe, and roll back on its own if the
      // probe fails. `--rollback` is the same machinery pointed backwards.
      const strategy = values.strategy ?? (values.rollback !== undefined ? 'blue-green' : 'restart');
      // The flag and the env var mean the same thing everywhere `server-deploy` can run, not just
      // on blue-green — see `.ai/specs/2026-08-22-server-deploy-dry-run-flag.md`.
      const dryRun = Boolean(values['dry-run']) || process.env.CEZ_DRY_RUN === '1';
      if (strategy !== 'restart') {
        process.exitCode = await releaseDeployCommand({
          strategy,
          rollback: values.rollback,
          follow: Boolean(values.follow),
          source: values.source ?? repoRoot,
          linkPath: values['link-path'],
          releasesDir: values['releases-dir'],
          releaseId: values['release-id'],
          unit: values.unit,
          port: portExplicit ? Number(values.port) : undefined,
          sha: values.sha,
          note: values.note,
          dryRun,
          allowStaleArtifact: Boolean(values['allow-stale-artifact']),
          refuseDirty: Boolean(values['refuse-dirty']),
          allowUnrelated: Boolean(values['allow-unrelated']),
        });
        return;
      }
      await serverCommand('deploy', repoRoot, values.platform, {
        yes: Boolean(values.yes),
        domain: values.domain,
        dryRun,
      });
      return;
    }
    case 'server-migrate-releases':
      // One-shot, idempotent: turn a hand-provisioned box into the release layout this spec needs
      // (P1) and install the socket/slice units (P3/P4). Separate from `server-install` because
      // the live unit on `prod-host` is hand-written — no generator in this repo authored
      // it — so a fresh install and an existing box need different, equally supported paths.
      process.exitCode = await migrateReleasesCommand({
        source: values.source ?? repoRoot,
        linkPath: values['link-path'],
        releasesDir: values['releases-dir'],
        unit: values.unit,
        port: portExplicit ? Number(values.port) : undefined,
        bindHost: values['bind-host'],
        apply: Boolean(values.yes),
      });
      return;
    case 'server-uninstall':
      await serverCommand('uninstall', repoRoot, values.platform, {
        yes: Boolean(values.yes),
        domain: values.domain,
      });
      return;
    case 'supervisor':
      await supervisorCommand(Number(values.port), values['bind-host']);
      return;
    // NB no `case 'run-broker'` here. It is dispatched from raw argv above the strict `parseArgs`,
    // because its own flags never survive that parser — and a `case` here that LOOKS live while
    // being unreachable is precisely how the broker shipped broken. See the block above.
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
 *
 * `bindHost` is threaded through to `registerAndAdoptProject` (D13, FIX A3) — it is `undefined`
 * for every caller except `serveCommand` (`run`, `cezar projects` have no bind at all), and
 * `isLocalOrgModeActive`'s own doc comment covers why `undefined` correctly reads as loopback
 * there rather than as "unknown".
 *
 * **FIX 5 (D13 repair pass 1) is now inside `registerAndAdoptProject`
 * (`./registered-project-roots.ts`), not inlined here** — file the freshly-registered (or
 * already-known) project under the local org, if one already exists, on EVERY registration, not
 * only the onboarding-time one `OnboardingRouteDeps.listRegisteredProjectRoots` covers. See that
 * function's own doc comment (FIX A1/A3/A4, D13 repair round 2) for why it moved: a project
 * registered here used to call `adoptRegisteredProjectIntoLocalOrg` inline, unconditionally, with
 * no local-org-mode guard and with an adoption failure able to swallow this function's own
 * unrelated `return entry.id` — both fixed at the one call site every non-HTTP registration path
 * now shares.
 */
async function initWorkspace(repoRoot: string, bindHost?: string): Promise<string | undefined> {
  try {
    await runMigrations({ bootRepoRoot: repoRoot });
    // D3 (`.ai/specs/2026-08-07-org-scoped-tasks-knowledge.md`): boot never auto-registers the
    // launch directory — see `suppressBootRegistration`'s own doc comment for why the D15 version
    // of this, which suppressed only while onboarding was incomplete, merely deferred the reported
    // bug by one launch. `shouldRegisterProject` is retained ahead of it because it still answers a
    // different question ("is this root registrable at all") that phase 5's offer UI must ask
    // before offering anything.
    if ((await shouldRegisterProject(repoRoot)) && !suppressBootRegistration()) {
      const entry = await registerAndAdoptProject(repoRoot, { bindHost });
      return entry.id;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] workspace registry unavailable (${message}) — continuing without it`);
  }
  return undefined;
}

/**
 * Change A of `.ai/specs/2026-08-21-workspace-boot-repo-and-always-worktrees.md`: if the launch
 * directory is cezar's own scratch root, make it a git repository so tasks homed there can be
 * isolated, and tell the `RunManager` that is what it is bound to.
 *
 * The `holdsOnlyRuntimeState` gate is the whole safety of this: `cezar serve` is routinely
 * launched from inside a real project, and boot never registers the launch directory
 * (`suppressBootRegistration` is unconditional), so nothing else distinguishes the two. A repo
 * that holds work keeps every behaviour it has today.
 *
 * Idempotent and never fatal. A failure here degrades to exactly the pre-spec behaviour — the
 * root stays non-git, tasks run in place one at a time — so it is a warning, not a boot failure
 * (`AGENTS.md`: degrade, never fail the boot). The flag is still returned in that case: grant
 * adoption (change C) needs no repository at the boot root, and it is the half that answers the
 * owner's report.
 */
async function prepareBootScratchRoot(repoRoot: string): Promise<boolean> {
  if (!(await holdsOnlyRuntimeState(repoRoot))) return false;
  const outcome = await ensureBootRepo(repoRoot);
  if ('error' in outcome) {
    console.warn(
      `[cez] could not make the boot root a git repository (${outcome.error}) — tasks homed in ${repoRoot} will run in place, one at a time`,
    );
    return true;
  }
  if (outcome.state === 'created') {
    console.log(`  initialized the boot root as a git repository (branch ${outcome.branch}) so tasks homed here isolate`);
  }
  return true;
}

// ---- serve -----------------------------------------------------------------

async function serveCommand(
  repoRoot: string,
  preferredPort: number,
  openBrowser: boolean,
  bindHost?: string,
  /**
   * `--port-strict` / `CEZ_PORT_STRICT=1` (D10, spec .ai/specs/2026-08-06-org-team-auth-onboarding.md):
   * `preferredPort` becomes a hard requirement instead of a preference — `pickPort`'s normal
   * silent forward-scan is refused. `server-install --platform hetzner` writes
   * `Environment=CEZ_PORT_STRICT=1` into every ORG unit's systemd file
   * (`server-install/platforms/hetzner/systemd-unit.ts#orgSystemdUnit`) because nginx's
   * `proxy_pass` for that org is a specific loopback port baked in at provisioning time: a
   * drifted bind there is not a startup failure, it is silent cross-tenant traffic (D10 Risks).
   */
  portStrict = false,
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

  // ---- port-strict refusal (D10) — same "refuses to boot means did nothing" discipline as the
  // auth gate above, and for the identical reason: checked and returned BEFORE initWorkspace,
  // reclaimWorktrees or manager.recover() run, so a busy strict port never leaves half-migrated
  // workspace state behind it.
  // Socket activation (spec `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`, P3).
  // Consumed HERE, before the port-strict refusal, because the two interact: under activation the
  // port IS already bound — by systemd, on our behalf — so probing it would find it busy and
  // refuse to boot, turning the feature that removes the bind gap into a permanent outage.
  // `consume` also scrubs LISTEN_* from the environment so the agent CLIs cezar spawns never
  // inherit them and mistake their own fd 3 for a listening socket.
  const activation = consumeSocketActivation(process.env, process.pid);
  const listenFd = activation.activated ? activation.socket.fd : undefined;

  if (portStrict && listenFd === undefined && !(await canListen(preferredPort))) {
    console.error(
      `\n  ✗ port ${preferredPort} is already in use, and --port-strict / CEZ_PORT_STRICT=1 is set — ` +
        `refusing to silently pick a different one.\n` +
        `    A hosted org's nginx proxy_pass is baked in to this exact port at provisioning time; ` +
        `drifting here would route that org's traffic into whatever else is listening on the next ` +
        `free port instead.\n`,
    );
    process.exitCode = 1;
    return;
  }

  let sessionResolver: SessionResolver | undefined;
  let authRoutes: Hono | undefined;
  let onboardingRoutes: Hono | undefined;
  let inviteRoutes: Hono | undefined;
  let teamRoutes: Hono | undefined;
  if (gate.provider === 'supervisor') {
    // ---- D10: this process is an ORG process behind `cezar supervisor`. ------------------------
    //
    // It does NOT terminate authentication and must never open `<CEZ_HOME>/identity/*.json` —
    // under D4 that directory does not exist here, and D10 assigns it to the one supervisor
    // process. So this branch deliberately does none of what the `oidc`/`google` branch below
    // does: no `./auth/session.ts` (which opens an `IdentityStore` at MODULE scope, i.e. merely
    // importing it would create the directory), no
    // `authRoutes`/`onboardingRoutes`/`inviteRoutes`/`teamRoutes` (mounting a second login/admin
    // surface on a loopback port every local uid can reach), and no bootstrap-code banner (there
    // is no local store for a code to claim).
    //
    // ADDED 2026-08-07 at the repair stage. Before it, `if (gate.provider !== 'none')` swallowed
    // `'supervisor'` and wired the COOKIE resolver — so every request to every org host 401'd,
    // permanently, with all five gates green. See `./supervisor/forwarded-session.ts`'s own
    // module doc comment for why no test caught it.
    const forwardedMod = await import('./supervisor/forwarded-session.ts');
    const supervisorGate = forwardedMod.resolveSupervisorModeGate(process.env);
    if (!supervisorGate.proceed) {
      if (supervisorGate.message) console.error(supervisorGate.message);
      process.exitCode = 1;
      return;
    }
    sessionResolver = forwardedMod.forwardedSessionResolver;
  } else if (gate.provider !== 'none') {
    // Lazy by construction (D1: "unset means zero I/O … never loads them") — this branch only
    // ever runs once CEZ_AUTH names a real provider, loopback or hosted alike (the D1 table's
    // second row: local + oidc/google still requires login). `./auth/session.ts` opens the
    // identity store at module scope, so it must never become a static import at the top of this
    // file: a dynamic `import()` is evaluated when this line runs and not before, which is what
    // keeps THIS BRANCH's path free of any filesystem work when it does not run.
    //
    // **CORRECTED 2026-08-07 by D13: "keeps the npm default path free of any filesystem work" no
    // longer describes the npm default path as a whole — only this branch's contribution to it.**
    // The `else` branch below (D13, `local-mode-boot.ts#buildLocalModeRoutes`) is what the npm
    // default (loopback, `CEZ_AUTH` unset) actually reaches, and it dynamically imports
    // `./auth/onboarding-routes.ts`/`./auth/team-routes.ts`, which statically import
    // `./auth/session.ts` — so `session.ts` DOES load on the npm default path now, just via that
    // other branch, on every loopback boot rather than only once `CEZ_AUTH` names a provider. It
    // still does no actual filesystem I/O at import time (`IdentityStore.open` is a bare
    // constructor — see `session.ts`'s own doc comment, corrected the same way), so "free of
    // filesystem work" survives in its narrower, behavioural sense; "this branch's import never
    // runs on the npm default path" survives literally, unchanged.
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
    const [sessionMod, routesMod, onboardingMod, inviteMod, teamMod, claimMod, identityMod, pathsMod] = await Promise.all([
      import('./auth/session.ts'),
      import('./auth/routes.ts'),
      // D8 onboarding (phase 4/5) — same "string literal, never a variable specifier" discipline
      // as the two imports above and for the identical reason (see the paragraph this comment
      // continues): a variable specifier is opaque to `npm run typecheck` in both directions, so
      // a wrong path here would only ever be caught at runtime, by a boot that never happens on
      // the npm-default `CEZ_AUTH` unset path.
      import('./auth/onboarding-routes.ts'),
      // 5b invites — same string-literal discipline as the two imports above, for the same reason.
      import('./auth/invite-routes.ts'),
      // 5c team management — same string-literal discipline, same reason.
      import('./auth/team-routes.ts'),
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
    inviteRoutes = inviteMod.inviteRoutes;
    teamRoutes = teamMod.teamRoutes;
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
  } else {
    // ---- D13: local-mode onboarding, spec .ai/specs/2026-08-06-org-team-auth-onboarding.md ------
    //
    // `gate.provider` is `'none'` here (the two branches above matched `'supervisor'` and every
    // other named provider), which covers TWO topologies (D1's table): loopback with `CEZ_AUTH`
    // unset (the npm zero-config default) AND hosted with `CEZ_AUTH` unset plus
    // `CEZ_ALLOW_UNAUTHENTICATED=1`. D13 is about the FIRST one only.
    //
    // FIX B1 (D13 repair round 2, adversarial review): this used to be `else if
    // (resolveCapabilities(process.env, bindHost).localHandoff)`, with the ~45-line wiring body
    // inline — the ONLY thing standing between the hosted-unauthenticated topology and mounting the
    // full local `/auth/onboarding*` + `/auth/teams*` surface, with ZERO test coverage, because
    // `src/index.ts` is the CLI entry no test imports (the identical defect `./auth-boot-gate.ts`
    // was extracted from this same file to fix — see that module's own doc comment). Worse, the
    // inline condition only re-derived HALF of D13's real predicate (the bind check) and relied on
    // this branch's position after the two `if`/`else if`s above to supply the other half (`gate.
    // provider === 'none'`) — a reordering of those branches could have stranded it reachable on an
    // authenticated topology with nothing here to notice.
    //
    // The whole decision AND the wiring now live in `./local-mode-boot.ts#buildLocalModeRoutes`,
    // unit-tested directly (`local-mode-boot.test.ts`): it re-asks the FULL two-part predicate via
    // `isLocalOrgModeActive` as its own first statement rather than trusting control-flow position,
    // and a mutation removing its bind check is caught there. See that module's own doc comment for
    // the full reasoning, including why the wiring itself — not just the boolean — had to move: a
    // deleted `else if` body left `onboardingRoutes`/`teamRoutes` `undefined` with every gate green.
    const localMode = await buildLocalModeRoutes(process.env, bindHost);
    if (localMode.active) {
      onboardingRoutes = localMode.onboardingRoutes;
      teamRoutes = localMode.teamRoutes;
    }
  }

  // `bindHost` threaded through so the registration seam's own local-org-mode guard (D13, FIX A3)
  // reads the SAME bind this process actually serves on, not `undefined`/loopback by default.
  const bootProjectId = await initWorkspace(repoRoot, bindHost);
  // ONE workspace semaphore for the whole process (spec 2026-07-20, step 2.5):
  // the boot manager and every lazily-built project context count their runs
  // against the same `resources.maxParallel`. The boot refresh() below is the
  // cache hook's first call; PUT /api/workspace/config (step 2.7) re-fires it.
  const semaphore = new WorkspaceSemaphore();
  await semaphore.refresh();
  // Before the store opens and before anything pumps: `getRepoInfo(repoRoot)` below, the startup
  // worktree reconcile, and `manager.recover()` must all see the repository if there is to be one.
  const bootScratchRoot = await prepareBootScratchRoot(repoRoot);
  // keepLive + recover() (#367): runs that were queued/running/waiting when
  // the previous process exited are re-queued or resumed instead of failed.
  const store = openStore(repoRoot, { keepLive: true });
  const manager = new RunManager(store, repoRoot, { semaphore, bootScratchRoot });
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
    // Cross-project ownership check (spec 2026-08-22-cross-project-worktree-orphan-prune-safety,
    // Layer 1): this process IS the boot root, so its own candidate list is every OTHER registered
    // project (no separate boot-root entry needed — the `!= repoRoot` filter would drop it anyway).
    // `loadWorkspaceConfig()` is the cheap raw registry read — `listProjects()` additionally shells
    // out a git status/branch probe per project, unneeded cost on the hot boot path.
    const registeredProjects = (await loadWorkspaceConfig()).projects.filter(
      (p) => canonicalPath(p.root) !== canonicalPath(repoRoot),
    );
    const delay = Number(process.env.CEZ_SWEEP_DELAY_MS ?? 5 * 60_000);
    const sweepTimer = setTimeout(() => {
      const foreignSources = loadForeignWorkspaceRunSources(repoRoot, registeredProjects);
      const unreadableSource = foreignSources.find((s) => s.unreadable);
      const dataDir = join(repoRoot, '.ai/cezar');
      void pruneOrphans(repoRoot, new Set(store.listRuns().map((r) => r.id)), {
        findForeignOwner: (path) => findForeignWorkspaceOwner(repoRoot, path, foreignSources),
        ownershipCheckUnavailable: unreadableSource
          ? { reason: `project "${unreadableSource.projectName}"'s runs.json could not be read` }
          : undefined,
        onOutcome: (outcome) => {
          mkdirSync(dataDir, { recursive: true });
          appendFileSync(join(dataDir, 'worktree-reaps.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), runId: outcome.id, repoRoot, ...outcome })}\n`);
        },
      }).then((orphans) => {
        if (orphans.removed.length > 0) console.log(`  cleaned ${orphans.removed.length} orphaned worktree(s): ${orphans.removed.map((id) => id.slice(0, 8)).join(', ')}`);
        if (orphans.kept.length > 0) console.log(`  kept ${orphans.kept.length} unsafe-to-reclaim worktree(s): ${orphans.kept.map((d) => `${d.id.slice(0, 8)} (${d.reason})`).join(', ')}`);
        if (orphans.declined.length > 0) console.log(`  declined to reclaim ${orphans.declined.length} worktree(s): ${orphans.declined.map((d) => `${d.id.slice(0, 8)} (${d.reason})`).join(', ')}`);
      }).catch(() => undefined);
    }, Math.max(0, delay));
    sweepTimer.unref?.();
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

  const drain = new DrainController({ drainMs: resolveDrainMs(process.env) });
  const port = portStrict ? preferredPort : await pickPort(preferredPort);
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
    listenFd,
    // P3: the same controller the signal handlers below drain. Without it the server counts
    // nothing and registers nothing, and the drain has no work to do — which is exactly the state
    // this wiring was missing.
    drain,
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
    inviteRoutes,
    teamRoutes,
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
  // Graceful drain (spec `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`, P3).
  //
  // This used to be `store.flush(); process.exit(0)` — immediate and unconditional, cutting
  // in-flight responses mid-body and killing every SSE/WS stream without a word. Socket activation
  // removes the *bind* gap; it does nothing for requests already in flight on the outgoing
  // process, and this is that second half: stop accepting, tell live streams to reconnect, let
  // unary requests finish, then flush and go.
  //
  // Re-entrancy matters: systemd sends SIGTERM and, if we outlast TimeoutStopSec, SIGKILL. A
  // second signal while draining must not restart the drain or exit early — it is ignored.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        const report = await drain.drain();
        if (!report.clean) {
          console.log(`  drained with ${report.outstanding} request(s) still in flight after ${report.waitedMs}ms`);
        }
      } catch {
        // A drain that throws must never stop us flushing state below.
      }
      store.flush();
      process.exit(0);
    })();
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

// ---- supervisor (D4/D10, spec .ai/specs/2026-08-06-org-team-auth-onboarding.md) ---------------
// Lazily imported for the same reason server-install is below: `cezar supervisor` is an operator
// command for a per-org hosted deployment, not something the everyday `serve`/`run`/`init` import
// graph should carry. `./supervisor/index.ts` itself refuses to boot with CEZ_AUTH unset (its own
// gate, distinct from `./auth-boot-gate.ts`'s D1 table — see that module's doc comment) and prints
// its own message + sets a non-zero exit code, so this wrapper's whole job is the dynamic import,
// the direct port bind (no `pickPort` auto-fallback: D10 is explicit that a drifted port is silent
// cross-org traffic once nginx's static `proxy_pass` is in the picture, and the same reasoning
// applies to the supervisor's own well-known port), and shutdown wiring.
async function supervisorCommand(port: number, bindHost?: string): Promise<void> {
  const { startSupervisor } = await import('./supervisor/index.ts');
  const server = await startSupervisor({ port, bindHost });
  if (!server) return; // boot gate refused — message printed and exit code set already

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
  const name = workflowName ?? DEFAULT_WORKFLOW_NAME;
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

  const bootScratchRoot = await prepareBootScratchRoot(repoRoot);
  const store = openStore(repoRoot);
  // Headless tasks still appear in the cockpit later, so persist the same
  // task-local recovery event when a credential expires after the preflight.
  const providerRuntimeAuth = new ProviderRuntimeAuthObserver(providerAuth, () => {});
  providerRuntimeAuth.watch(store);
  // Headless runs enforce the same workspace-level cap/memory limit (step
  // 2.5) — one refreshed semaphore, even with just one manager in play.
  const semaphore = new WorkspaceSemaphore();
  await semaphore.refresh();
  const manager = new RunManager(store, repoRoot, { semaphore, bootScratchRoot });

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

  // A person typing at a terminal is a `user` with id `local` — the `approverOf` rule
  // (spec 2026-08-21-task-author-provenance). There is no session and no request here.
  const run = manager.startRun(workflow, { task, model, author: localCliAuthor('cli-run') });
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
    /** `--platform hetzner` only — see `RunOptions#orgSlug` (`server-install/engine.ts`). */
    orgSlug?: string;
    /** `--role worker` (Phase 4, D17) — see `RunOptions#role` (`server-install/engine.ts`). */
    role?: 'worker';
    /** `--join <code>` — see `RunOptions#clusterJoinToken` (`server-install/engine.ts`). */
    clusterJoinToken?: string;
    port?: number;
    externalProxy?: boolean;
    bindHost?: string;
    dryRun?: boolean;
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
  // Domain-keyed multi-instance: ubuntu-vps's optional SECOND cockpit, and hetzner's REQUIRED
  // one-instance-per-domain shape (every hetzner target — the supervisor and each org — is its
  // own named instance; `hetzner.ts`'s own preflight refuses to run without --domain at all).
  if (instance !== DEFAULT_SERVER_INSTANCE && !['ubuntu-vps', 'hetzner'].includes(chosen)) {
    console.error(`--domain (multi-instance) is only supported on ubuntu-vps and hetzner, not ${chosen}.`);
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
    dryRun: process.env.CEZ_DRY_RUN === '1' || Boolean(flags.dryRun),
    assumeYes: flags.yes,
    reconfigure: new Set((flags.reconfigure ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    reinstall: Boolean(flags.reinstall),
    repoRoot,
    now: new Date().toISOString(),
    instance,
    domain,
    orgSlug: flags.orgSlug,
    role: flags.role,
    clusterJoinToken: flags.clusterJoinToken,
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
    'tmp/', // per-run agent temp directories (#785)
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

// ---- cluster (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`) ---------------------------

const CLUSTER_USAGE = `usage:
  cez cluster enroll [--name <node name>] [--ttl <seconds>] [--json]
                              hub: mint a single-use join code and print the one-liner
                              a new node runs. The code is shown ONCE — only its
                              SHA-256 digest is stored — and the command it renders
                              carries the code and nothing else: never an Access
                              client id or secret.
  cez cluster join <code> [--name <node name>] [--json]
                              spoke: redeem a code against the hub it names. Every
                              failure is one of five NAMED reasons — access-rejected ·
                              code-expired · code-used · hub-unreachable ·
                              protocol-major — because an operator who cannot tell an
                              Access rejection from a stale code will re-mint codes to
                              fix a credential problem.
  cez cluster active [--json]  what is in flight across the cluster: task summary,
                              node, branch, touched paths. Read this before starting
                              work in a repo somebody else may already be holding.
  cez cluster reconcile [--apply] [--dry-run] [--peer <nodeId>]
                              spoke → hub only: full compare against the hub's
                              backlog for every project this node has confirmed
                              paired with it. Three classes: one side only ·
                              identical · differing-and-neither-saw-the-hub. The
                              third is REFUSED, never auto-merged: no fact
                              available says which side is right. DRY RUN IS THE
                              DEFAULT — nothing is written unless you pass
                              --apply. --dry-run forces a dry run even alongside
                              --apply, for a script that wants to force the safe
                              path regardless of its own flags.
  cez cluster revoke <nodeId>  hub: disable a node.
  cez cluster revoke --self    spoke: delete THIS node's credential. Revocation is
                              two-sided — a hub-side revoke alone does not stop a
                              spoke from continuing to push.`;

const CLUSTER_OFF_CLI =
  'cez cluster: clustering is off — set CEZ_CLUSTER=1 (and CEZ_CLUSTER_HUB=<url> to join one as a spoke) and restart cezar';

/**
 * `cez cluster …`. Filesystem + HTTP only: no server to talk to, no auth wall, exactly like
 * `cez kb` and `cez todo`, which is what lets `cez cluster active` be a read an agent can make
 * from inside a run over the `Bash` surface it already has (D19 rung 4).
 *
 * Returns the process exit code — 0 on success, 1 on a usage error or a genuine failure.
 *
 * Every subcommand is wrapped in one try/catch on purpose. The `cluster/*` modules are landing
 * package by package, so a subcommand whose module has not been filled in yet throws a NAMED
 * `not implemented: … package N.N` error; printing that one line beats an unhandled rejection's
 * stack, and it tells whoever hits it exactly which package they are waiting on.
 */
async function runClusterCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(CLUSTER_USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (!clusterEnabled(process.env)) {
    console.error(CLUSTER_OFF_CLI);
    return 1;
  }

  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: args.slice(1),
      options: {
        name: { type: 'string' },
        ttl: { type: 'string' },
        peer: { type: 'string' },
        // `reconcile`'s own pair — see the case body for why the default is DRY RUN despite
        // both flags themselves defaulting to `false` (there is no `--no-x` negation in
        // `node:util`'s `parseArgs`, so "dry run unless told otherwise" has to be computed from
        // the ABSENCE of `--apply`, not from either flag's own default).
        'dry-run': { type: 'boolean', default: false },
        apply: { type: 'boolean', default: false },
        self: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    console.error(`cez cluster: ${err instanceof Error ? err.message : String(err)}`);
    console.error(CLUSTER_USAGE);
    return 1;
  }

  const json = values.json === true;
  const emit = (value: unknown, lines: () => string[]): void => {
    if (json) console.log(JSON.stringify(value, null, 2));
    else for (const line of lines()) console.log(line);
  };

  try {
    switch (sub) {
      case 'enroll': {
        const ttlSeconds = values.ttl === undefined ? undefined : Number(values.ttl);
        if (ttlSeconds !== undefined && !Number.isFinite(ttlSeconds)) {
          console.error('cez cluster enroll: --ttl must be a number of seconds');
          return 1;
        }
        const { response } = await createEnrollmentCode({
          ...(typeof values.name === 'string' ? { nodeName: values.name } : {}),
          ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
          hubUrl: clusterHubUrl(),
          hubVersion: readOwnVersion(),
        });
        emit(response, () => [
          `code:      ${response.code}`,
          `code id:   ${response.codeId}   (revoke with: DELETE /api/v1/cluster/enroll/${response.codeId})`,
          `expires:   ${response.expiresAt}`,
          '',
          'On the node you are adding, run ONE of:',
          `  ${response.commands.join}`,
          `  ${response.commands.provision}`,
          '',
          'Single use, and shown once — the hub keeps only a SHA-256 digest and cannot print it again.',
        ]);
        return 0;
      }

      case 'join': {
        const code = positionals[0];
        if (!code) {
          console.error('cez cluster join: pass the code the hub printed — `cez cluster join <code>`');
          return 1;
        }
        // `joinCluster` owns the credential write (`persistNodeCredential`, 0600). The CLI never
        // touches the secret, so it has exactly one writer, and it is never echoed to a terminal
        // whose scrollback is somebody's shell history.
        const result = await joinCluster({
          code,
          ...(typeof values.name === 'string' ? { nodeName: values.name } : {}),
          protocol: CLUSTER_PROTOCOL,
        });
        if (!result.ok) {
          // The REASON is the value; the message is detail nothing branches on.
          console.error(`cez cluster join: refused — ${result.reason}${result.message ? `: ${result.message}` : ''}`);
          if (json) console.log(JSON.stringify(result, null, 2));
          return 1;
        }
        emit({ ok: true, nodeId: result.nodeId, hubNodeId: result.hubNodeId, hubUrl: result.hubUrl }, () => [
          `joined ${result.hubUrl} as ${result.nodeId}`,
          `hub:    ${result.hubNodeId}`,
          `protocol ${result.protocol.major}.${result.protocol.minor}`,
          '',
          'This node accepts NO dispatched work until you turn it on — Settings → Cluster, or',
          'PATCH /api/v1/cluster/nodes/<nodeId> {"acceptsDispatch":true}. It replicates either way.',
        ]);
        return 0;
      }

      case 'active': {
        const runs = clusterActiveRunsFrom(await readRemoteRuns());
        emit({ runs, asOf: new Date().toISOString() }, () =>
          runs.length === 0
            ? ['nothing in flight on any linked node.']
            : runs.map(
                (run) =>
                  `${run.nodeId}  ${run.runId}  ${run.branch ?? '(no branch)'}  ${run.summary ?? ''}`.trim(),
              ),
        );
        return 0;
      }

      case 'reconcile': {
        // D21 (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`): reads over HTTP (the ONE new
        // route, `GET /cluster/todos/:projectKey`) and writes over the same family's `/backup` +
        // `/append` — `cluster/reconcile-transport.ts#createHttpReconcileTransport`, signed with
        // D20's node principal. Runs FROM a spoke AGAINST its hub — the only direction addressable
        // at all (a spoke has no inbound address, Problem §7) — so this refuses outright on a hub
        // and on a `--peer` that does not resolve to THIS node's own hub.
        const peerNodeId = typeof values.peer === 'string' ? values.peer : await soleClusterPeer();
        if (!peerNodeId) return 1;

        const identity = await loadNodeIdentity();
        if (!identity) {
          console.error('cez cluster reconcile: this node has no cluster identity — run `cez cluster join <code>` first');
          return 1;
        }
        if (identity.role !== 'spoke' || !identity.hubUrl) {
          console.error(
            'cez cluster reconcile: this node IS the hub — reconcile dials OUT from a spoke to its hub, and a hub reconciling against a spoke is out of scope (D21); there is nothing to dial from here',
          );
          return 1;
        }
        if (!identity.secret) {
          console.error(
            'cez cluster reconcile: this node has no cluster secret on file — re-run `cez cluster join <code>` to re-enroll',
          );
          return 1;
        }

        const peers = await readPeers();
        if (peers.nodes.find((node) => node.nodeId === peerNodeId)?.role !== 'hub') {
          console.error(
            `cez cluster reconcile: ${peerNodeId} is not this node's hub — reconcile only runs from a spoke against its own hub (reachable at ${identity.hubUrl})`,
          );
          return 1;
        }

        // `resolveLocalDataDir`: a confirmed pairing's `byNode[thisNodeId].projectId` → the
        // workspace project registry's `root` (`ReconcileOptions`'s own doc, package 2.4's report).
        // Built ONCE, synchronously, from THIS pass's own snapshot of `peers`/the registry — never
        // re-read per project, so a pairing edited mid-run cannot make one project's resolution
        // disagree with another's inside the same pass.
        const config = await loadWorkspaceConfig();
        const projectsById = new Map(config.projects.map((project) => [project.id, project]));
        const localDataDirByProject = new Map<string, string>();
        for (const pairing of peers.pairings) {
          const member = pairing.byNode[identity.nodeId];
          if (!member?.confirmedAt) continue;
          const project = projectsById.get(member.projectId);
          if (project) localDataDirByProject.set(pairing.projectKey, join(project.root, '.ai/cezar'));
        }

        // DRY RUN IS THE DEFAULT (D21: "the real merge is owner-gated … `--dry-run` is the default
        // posture"). `--apply` is the one way to opt into writing; `--dry-run` always forces a dry
        // run even alongside `--apply`, so a script combining both stays on the safe side rather
        // than depending on flag ORDER.
        const dryRun = values['dry-run'] === true || values.apply !== true;

        const reports = await reconcileAll({
          dryRun,
          peerNodeId,
          resolveLocalDataDir: (projectKey) => {
            const dataDir = localDataDirByProject.get(projectKey);
            if (!dataDir) {
              // `listProjects()` and this map are built from the SAME `peers` snapshot, so this is
              // a wiring bug, not a caller mistake — named rather than a bare `undefined!` cast.
              throw new Error(`cez cluster reconcile: no confirmed local project for "${projectKey}"`);
            }
            return dataDir;
          },
          remote: createHttpReconcileTransport({
            nodeId: identity.nodeId,
            secret: identity.secret,
            hubUrl: identity.hubUrl,
          }),
        });

        emit({ dryRun, peer: peerNodeId, reports }, () => {
          if (reports.length === 0) {
            return [`no confirmed, paired project reconciled against ${peerNodeId} — nothing to do.`];
          }
          const lines: string[] = [];
          for (const report of reports) {
            const { counts } = report;
            lines.push(
              `${report.projectKey}: local-only ${counts['local-only']}  remote-only ${counts['remote-only']}  ` +
                `identical ${counts.identical}  divergent-unclocked ${counts['divergent-unclocked']}` +
                (report.backupPaths.length > 0 ? `  (backed up: ${report.backupPaths.join(', ')})` : ''),
            );
            if (counts['divergent-unclocked'] > 0) {
              lines.push(
                `  ${counts['divergent-unclocked']} row(s) diverge with neither side ever seen by the hub — REFUSED, not merged; resolve by hand.`,
              );
            }
          }
          lines.push(
            dryRun
              ? '(dry run — nothing was written; re-run with --apply to write.)'
              : '(written.)',
          );
          return lines;
        });
        return 0;
      }

      case 'revoke': {
        if (values.self === true) {
          await leaveCluster();
          console.log('this node’s cluster credential is deleted. Ask the hub to disable the node too —');
          console.log('a spoke-side delete stops this node pushing, and a hub-side revoke stops the hub');
          console.log('answering; revocation is only complete with both.');
          return 0;
        }
        const nodeId = positionals[0];
        if (!nodeId) {
          console.error('cez cluster revoke: name the node — `cez cluster revoke <nodeId>` — or `--self` to drop THIS node’s credential');
          return 1;
        }
        const revoked = await disableNode(nodeId);
        if (!revoked) {
          console.error(`cez cluster revoke: no node ${nodeId} in the roster`);
          return 1;
        }
        console.log(`${nodeId} is disabled on this hub.`);
        console.log('Run `cez cluster revoke --self` ON THAT NODE too — a hub-side revoke alone does not stop');
        console.log('a spoke from continuing to push ops.');
        return 0;
      }

      default:
        console.error(`cez cluster: unknown subcommand "${sub}"`);
        console.error(CLUSTER_USAGE);
        return 1;
    }
  } catch (err) {
    console.error(`cez cluster ${sub}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** The hub's own URL, for the join command it renders. Discovered before configured, the shape
 *  `notifications-routes.ts#discoverCockpitUrl` already settled. Loopback is the last resort and is
 *  useless in a pasted command — which is exactly why an operator who has not set one gets a
 *  visibly-local URL rather than a plausible wrong one. */
function clusterHubUrl(): string {
  const configured = process.env.CEZ_CLUSTER_HUB?.trim() || process.env.CEZ_COCKPIT_URL?.trim();
  if (configured) return configured;
  const state = loadInstalledServerState();
  return state.domain ? `https://${state.domain}` : `http://127.0.0.1:${state.primaryPort}`;
}

/** `--peer` omitted: fall back to the one other node in the roster, and refuse rather than guess
 *  when there is none or more than one. Reconciling against the wrong peer writes another repo's
 *  backlog into this one, so this fails closed. */
async function soleClusterPeer(): Promise<string | undefined> {
  const self = await loadNodeIdentity();
  const peers = await readPeers();
  const others = peers.nodes.filter((node) => node.nodeId !== self?.nodeId && !node.disabledAt);
  if (others.length === 1) return others[0]!.nodeId;
  if (others.length === 0) {
    console.error('cez cluster reconcile: no other node in the roster to reconcile against');
    return undefined;
  }
  console.error(
    `cez cluster reconcile: name the peer with --peer <nodeId> — the roster holds ${others.length}: ${others
      .map((node) => node.nodeId)
      .join(', ')}`,
  );
  return undefined;
}

// ---- `cez kb submit` — the spoke's one write path to the record ------------------------------

const KB_SUBMIT_USAGE = 'usage: cez kb submit <corpus-path> [--content "..."] [--note "..."] [--json]';

/**
 * Forwards a knowledge write to the hub (`POST /api/v1/cluster/corpus/submit`) — **the only write
 * direction the corpus has** (D8/D8a). The path is corpus-relative (`knowledge/foo.md`), and the
 * body comes from `--content` or stdin, the same two sources `cez kb write` accepts.
 *
 * It exists because a prohibition on its own gets routed around: `--add-dir` already grants an
 * agent write access to the mirror path, so `readOnly: true` on a spoke's root is not sufficient.
 * The sweep quarantines a diverged file rather than overwriting it, and this is the correct path
 * that is easier than the wrong one.
 *
 * A HUB refuses: there is nothing to forward to, and the corpus is right here — `cez kb write`.
 *
 * **Signed with `cluster/node-auth.ts` (D20).** This used to POST with no auth headers at all —
 * D20 gated the route behind node auth without updating this, its own caller. The body string is
 * built once and reused for both the signature's `bodyHash` and the actual request body, and
 * `path`/`method` are read off the same `URL` the request is sent to, so the principal is signed
 * over exactly what goes over the wire (node-auth.ts's own docblock on why that binding matters).
 * The hub cannot verify any of this yet — nothing persists a node's secret hub-side (see
 * `node-auth.ts`'s module header) — so every submit fails closed with 401 `unknown-node` until
 * that store lands; `describeHubRefusal` below names that gap explicitly rather than reporting a
 * bare HTTP status, without adding any fallback that would sign as though it might not matter.
 *
 * Not exported: this module runs `main()` at load, so importing it from a test executes the CLI.
 * `kb-submit-signing.test.ts` (repo root of this package's `src/`) drives this command the correct
 * way instead — a SUBPROCESS through the real entry point, against a real local HTTP hub, checked
 * with the real `verifyNodeHttpPrincipal` — and is what proves this specific caller (not just
 * `signedNodeRequestHeaders` in isolation, covered generically in `cluster/node-auth.test.ts`)
 * actually signs with the node's real identity, refuses closed with no secret on file, and turns a
 * 401 `unknown-node` into `describeHubRefusal`'s message below rather than a bare HTTP status.
 */
async function runKbSubmitCommand(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(KB_SUBMIT_USAGE);
    return 0;
  }
  if (!clusterEnabled(process.env)) {
    console.error('cez kb submit: clustering is off — with no hub to forward to, write the corpus directly (`cez kb write`)');
    return 1;
  }

  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        content: { type: 'string' },
        note: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    console.error(`cez kb submit: ${err instanceof Error ? err.message : String(err)}`);
    console.error(KB_SUBMIT_USAGE);
    return 1;
  }

  const path = positionals[0];
  if (!path) {
    console.error(KB_SUBMIT_USAGE);
    return 1;
  }

  const body = typeof values.content === 'string' ? values.content : await readAllStdin();
  if (body.trim() === '') {
    console.error('cez kb submit: no content given; pass --content "..." or pipe it on stdin');
    return 1;
  }

  const identity = await loadNodeIdentity();
  if (!identity) {
    console.error('cez kb submit: this node has no cluster identity — run `cez cluster join <code>` first');
    return 1;
  }
  if (identity.role !== 'spoke' || !identity.hubUrl) {
    console.error('cez kb submit: this node IS the hub — the corpus is local here, so write it directly (`cez kb write`)');
    return 1;
  }
  if (!identity.secret) {
    console.error(
      'cez kb submit: this node has no cluster secret on file — re-run `cez cluster join <code>` to re-enroll',
    );
    return 1;
  }

  try {
    const url = new URL('/api/v1/cluster/corpus/submit', identity.hubUrl);
    const signed = signedNodeRequestHeaders({
      nodeId: identity.nodeId,
      secret: identity.secret,
      method: 'POST',
      url,
      bodyText: JSON.stringify({
        path,
        body,
        ...(typeof values.note === 'string' ? { note: values.note } : {}),
      }),
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed.headers },
      body: signed.body,
    });
    const payload = (await response.json().catch(() => null)) as ClusterCorpusSubmitResponse | { error?: string; reason?: string } | null;
    if (!response.ok) {
      console.error(`cez kb submit: ${describeHubRefusal(response.status, payload)}`);
      return 1;
    }
    if (payload && 'ok' in payload && payload.ok === false) {
      console.error(`cez kb submit: refused — ${payload.reason}${payload.message ? `: ${payload.message}` : ''}`);
      return 1;
    }
    if (values.json === true) console.log(JSON.stringify(payload, null, 2));
    else if (payload && 'ok' in payload && payload.ok) console.log(`submitted ${payload.path} (corpus ${payload.corpusVersion})`);
    return 0;
  } catch (err) {
    console.error(`cez kb submit: could not reach the hub at ${identity.hubUrl} — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * Turns a non-2xx `/cluster/corpus/submit` response into the message an operator reads. A plain
 * `${detail}` fallback would show `unknown-node`'s own wording verbatim — "this node is not known
 * to the hub — enroll it first" — which is actively wrong advice right now: the request WAS
 * signed by an enrolled node, the hub just has nowhere to look its secret up (node-auth.ts's
 * module header, D20's known gap). Only that one reason gets renamed; every other 401
 * (`bad-signature`, `stale-principal`, `no-credentials`) already carries an accurate, actionable
 * message from `NODE_AUTH_MESSAGE` and is passed through unchanged.
 */
function describeHubRefusal(status: number, payload: unknown): string {
  const record = payload && typeof payload === 'object' ? (payload as { error?: unknown; reason?: unknown }) : {};
  if (status === 401 && record.reason === 'unknown-node') {
    return (
      'the hub rejected this signed request as unknown (401 unknown-node) — the hub does not yet ' +
      "persist per-node secrets, so every signed write fails this way until that store lands; this " +
      "is the known D20 gap, not a problem with this node's enrollment or this write"
    );
  }
  const detail = typeof record.error === 'string' && record.error ? record.error : `HTTP ${status}`;
  return `the hub refused — ${detail}`;
}

/** Stdin, or `''` when nothing is piped — mirrors `knowledge/cli.ts`'s own content fallback. */
async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function readOwnName(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { name?: string };
    return pkg.name ?? '@loki-labs/better-cezar';
  } catch {
    return '@loki-labs/better-cezar';
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
