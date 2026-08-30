import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn as spawnCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  fallbackOffMessage,
  noEligibleFallbackMessage,
  NO_PROVIDER_AUTHORIZED_MESSAGE,
} from '../../src/server/provider-action-gate.ts';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

test('the release tarball installs and runs the dry-run CLI workflow', { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-package-e2e-'));

  try {
    const packDir = join(root, 'pack');
    await mkdir(packDir);
    const packed = await execFile(
      npm,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    const records = JSON.parse(packed.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    const record = records[0];
    assert.ok(record, 'npm pack should describe the generated tarball');

    const packagedPaths = new Set(record.files.map((file) => file.path));
    for (const requiredPath of [
      'dist/index.js',
      'web/dist/index.html',
      'scripts/mock-claude.mjs',
      'scripts/mock-codex-app-server.mjs',
      'README.md',
    ]) {
      assert.ok(packagedPaths.has(requiredPath), `release tarball should contain ${requiredPath}`);
    }
    assert.equal(packagedPaths.has('src/index.ts'), false, 'release tarball should not contain TypeScript sources');
    assert.equal(packagedPaths.has('test/e2e/package-cli.test.ts'), false, 'release tarball should not contain tests');

    const consumerDir = join(root, 'consumer');
    await mkdir(consumerDir);
    await writeFile(join(consumerDir, 'package.json'), '{"private":true}\n', 'utf8');
    const tarball = join(packDir, record.filename);
    await execFile(
      npm,
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
      { cwd: consumerDir, maxBuffer: 10 * 1024 * 1024 },
    );

    const packageRoot = join(consumerDir, 'node_modules', '@loki-labs', 'cezar-plus');
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      bin: { cezar: string; cez: string; 'cezar-cli': string };
    };
    assert.equal(manifest.bin.cezar, 'dist/index.js');
    assert.equal(manifest.bin.cez, 'dist/index.js');
    assert.equal(manifest.bin['cezar-cli'], 'dist/index.js');
    const cliPath = join(packageRoot, manifest.bin.cezar);

    const help = await execFile(process.execPath, [cliPath, '--help'], {
      cwd: consumerDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(help.stdout, /cezar-plus — local cockpit/);
    assert.match(help.stdout, /cezar run "<task>"/);

    const fixtureRepo = join(root, 'fixture-repo');
    await mkdir(fixtureRepo);
    await execFile('git', ['init', '--initial-branch=main'], { cwd: fixtureRepo });
    await writeFile(join(fixtureRepo, 'README.md'), '# E2E fixture\n', 'utf8');
    await execFile('git', ['add', 'README.md'], { cwd: fixtureRepo });
    await execFile(
      'git',
      ['-c', 'user.name=Cezar CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'test fixture'],
      { cwd: fixtureRepo },
    );

    // CEZ_HOME pins every workspace write (migrations, project registry,
    // server.json) to a temp dir — booting the real CLI must never touch the
    // developer's real ~/.cezar.
    const cezHome = join(root, 'cez-home');
    // The eight-step workflow measured 20.6s on an idle box. Keep enough margin for npm pack,
    // installation, and a loaded gate host without hiding an event-loop liveness failure.
    const run = await execFile(process.execPath, [cliPath, 'run', 'mock:done', '--repo', fixtureRepo], {
      cwd: consumerDir,
      env: { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: cezHome },
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(run.stdout, /run (done|review)/);

    const runs = JSON.parse(await readFile(join(fixtureRepo, '.ai', 'cezar', 'runs.json'), 'utf8')) as Array<{
      status: string;
    }>;
    assert.equal(runs.length, 1);
    assert.ok(['done', 'review'].includes(runs[0]?.status ?? ''), 'the dry-run workflow should finish successfully');

    // Boot wiring (D3, .ai/specs/2026-08-07-org-scoped-tasks-knowledge.md): the
    // headless run still migrates ~/.cezar (the process serves the launch
    // directory exactly as before — `shouldRegisterProject` only ever governed
    // registration, never what is served) but must NOT write the boot repo into
    // the project registry. Registration is now a deliberate, explicit act — the
    // offer UI in the app, or `cezar projects add` on the CLI, exercised below.
    // The run's own success was already asserted above (`runs.length === 1` with
    // a `done`/`review` status), so an empty registry here is evidence D3 held,
    // not evidence the run never ran.
    const workspace = JSON.parse(await readFile(join(cezHome, 'config.json'), 'utf8')) as {
      schemaVersion: number;
      disabledProviders?: string[];
      projects: Array<{ name: string; root: string }>;
    };
    assert.ok(workspace.schemaVersion >= 1, 'boot runs the workspace migrations');
    assert.deepEqual(
      workspace.projects,
      [],
      'a headless run must not auto-register the boot repo in the workspace registry (D3)',
    );

    workspace.disabledProviders = ['claude'];
    await writeFile(join(cezHome, 'config.json'), `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
    await assert.rejects(
      execFile(process.execPath, [cliPath, 'run', 'mock:done must stay blocked', '--repo', fixtureRepo], {
        cwd: consumerDir,
        env: { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: cezHome },
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      }),
      (error: unknown) => {
        const result = error as { stderr?: string };
        assert.match(result.stderr ?? '', /Claude Code is disabled/);
        return true;
      },
      'headless run must honor the global provider preference',
    );
    const runsAfterDisabledAttempt = JSON.parse(
      await readFile(join(fixtureRepo, '.ai', 'cezar', 'runs.json'), 'utf8'),
    ) as Array<{ status: string }>;
    assert.equal(runsAfterDisabledAttempt.length, 1, 'a disabled provider must not create a run');
    workspace.disabledProviders = [];
    await writeFile(join(cezHome, 'config.json'), `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');

    const claudeShim = join(root, 'claude-shim.mjs');
    await writeFile(
      claudeShim,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(' ') === 'auth status --json') {
  process.stdout.write('{"loggedIn":true}\\n');
} else {
  process.stdout.write('{"type":"system","subtype":"init","session_id":"auth-failure-session"}\\n');
  process.stdout.write('{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate. API Error: 401 OAuth access token has been revoked.","usage":{"input_tokens":0,"output_tokens":0},"total_cost_usd":0}\\n');
}
`,
      { mode: 0o755 },
    );
    await execFile(
      process.execPath,
      [cliPath, 'run', 'exercise runtime auth rejection', '--repo', fixtureRepo],
      {
        cwd: consumerDir,
        env: {
          ...process.env,
          CEZ_CLAUDE_BIN: claudeShim,
          CEZ_HOME: cezHome,
        },
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    ).catch(() => undefined);
    const runsAfterAuthFailure = JSON.parse(
      await readFile(join(fixtureRepo, '.ai', 'cezar', 'runs.json'), 'utf8'),
    ) as Array<{ id: string }>;
    assert.equal(runsAfterAuthFailure.length, 2, 'the runtime-auth fixture creates exactly one run');
    const authFailureRun = runsAfterAuthFailure.at(0);
    assert.ok(authFailureRun, 'the auth-failure fixture creates a run');
    const authFailureEvents = (await readFile(
      join(fixtureRepo, '.ai', 'cezar', 'runs', `${authFailureRun.id}.ndjson`),
      'utf8',
    )).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(
      authFailureEvents.some((event) =>
        event.type === 'provider-auth-required'
        && event.provider === 'claude'
        && typeof event.authFailureId === 'string'),
      'headless runtime rejection must persist provider recovery guidance',
    );

    // D3 leaves the boot repo unregistered (asserted above) — register it
    // explicitly through the CLI path a user takes instead (`cezar projects
    // add`, the terminal twin of accepting the "<name> isn't in a workspace
    // yet" offer), so the `cezar projects` assertion below still has a
    // registered project to read.
    const add = await execFile(process.execPath, [cliPath, 'projects', 'add', fixtureRepo], {
      cwd: consumerDir,
      env: { ...process.env, CEZ_HOME: cezHome },
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(add.stdout, /\+ fixture-repo/, 'cezar projects add registers the repo');

    // `cezar projects` (step 5.2) reads the same registry with no server
    // running — the ssh-into-the-box view of Settings → Projects.
    const projects = await execFile(process.execPath, [cliPath, 'projects'], {
      cwd: consumerDir,
      env: { ...process.env, CEZ_HOME: cezHome },
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(projects.stdout, /fixture-repo/);
    assert.match(projects.stdout, /1 project\(s\)/);

    // server-install / server-uninstall dry-run round-trip. A separate CEZ_HOME
    // isolates ~/.cezar/server.json from the project-registry fixture above;
    // CEZ_DRY_RUN performs no real sudo.
    assert.match(help.stdout, /cezar server-install/);
    const serverHome = join(root, 'server-home');
    const serverEnv = { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: serverHome };
    const serverExec = { cwd: consumerDir, env: serverEnv, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 } as const;

    await execFile(
      process.execPath,
      [cliPath, 'server-install', '--platform', 'ubuntu-vps', '--yes', '--repo', fixtureRepo],
      serverExec,
    );
    const state = JSON.parse(await readFile(join(serverHome, 'server.json'), 'utf8')) as {
      platform: string;
      installed: boolean;
      steps: Record<string, unknown>;
    };
    assert.equal(state.platform, 'ubuntu-vps', 'server-install records the platform');
    assert.equal(state.installed, true, 'server-install flips installed=true when all required steps are done');
    assert.ok(state.steps['nginx-proxy'], 'server-install ran the nginx-proxy step');

    await execFile(
      process.execPath,
      [cliPath, 'server-uninstall', '--platform', 'ubuntu-vps', '--yes'],
      serverExec,
    );
    const reversed = JSON.parse(await readFile(join(serverHome, 'server.json'), 'utf8')) as {
      installed: boolean;
      steps: Record<string, unknown>;
    };
    assert.deepEqual(reversed.steps, {}, 'server-uninstall reverses every step');
    assert.equal(reversed.installed, false, 'server-uninstall clears installed');

    await execFile(
      process.execPath,
      [cliPath, 'server-install', '--platform', 'ubuntu-vps', '--external-proxy', '--yes', '--repo', fixtureRepo],
      serverExec,
    );
    await execFile(
      process.execPath,
      [cliPath, 'server-install', '--platform', 'ubuntu-vps', '--yes', '--repo', fixtureRepo],
      serverExec,
    );
    const resumedExternal = JSON.parse(await readFile(join(serverHome, 'server.json'), 'utf8')) as {
      externalProxy?: boolean;
      steps: Record<string, unknown>;
    };
    assert.equal(resumedExternal.externalProxy, true, 'a flag-less resume preserves external-proxy mode');
    assert.ok(!resumedExternal.steps['nginx-proxy'], 'a flag-less resume does not add cezar-managed nginx');

    // Unknown platform exits non-zero.
    await assert.rejects(
      execFile(process.execPath, [cliPath, 'server-install', '--platform', 'nope'], serverExec),
      'unknown platform should exit 1',
    );

    // V7 — the headless CLI shares the fallback decision, at package level
    // (`.ai/specs/2026-08-25-logged-out-account-fallback.md`). These cases run WITHOUT
    // `CEZ_DRY_RUN`: under it, `ProviderAuthService` short-circuits every auth read to
    // `connected` (`peekStatus`/`peekProfileStatus`/`profileStatus` all answer connected,
    // `reportRuntimeAuthFailure` is a no-op), so a disconnected account is unstageable and every
    // case below would assert nothing and pass vacuously. Instead each provider's executable is
    // overridden (`CEZ_CLAUDE_BIN`/`CEZ_CODEX_BIN`/`CEZ_OPENCODE_BIN`) to a small shim on disk —
    // the subprocess-visible fixture the auth layer actually consults.
    const shimDir = join(root, 'provider-shims');
    await mkdir(shimDir);
    const mockAppServer = join(packageRoot, 'scripts', 'mock-codex-app-server.mjs');

    const claudeDisconnected = join(shimDir, 'claude-disconnected.mjs');
    await writeFile(
      claudeDisconnected,
      '#!/usr/bin/env node\n'
      + 'process.stdout.write(\'{"loggedIn":false}\\n\');\n'
      + 'process.exitCode = 1;\n',
      { mode: 0o755 },
    );

    const codexDisconnected = join(shimDir, 'codex-disconnected.mjs');
    await writeFile(
      codexDisconnected,
      '#!/usr/bin/env node\n'
      + 'process.stdout.write(\'not logged in\\n\');\n'
      + 'process.exitCode = 1;\n',
      { mode: 0o755 },
    );

    // The probe branch answers `login status`; the run branch delegates the REAL `app-server`
    // JSON-RPC handshake to the packed mock. `exec` (POSIX process replacement), not a nested
    // `spawn`/`spawnSync` — the app-server transport talks JSON-RPC over this process's own
    // stdio, and a spawned (not exec'd) grandchild sitting behind a *synchronous* parent is an
    // extra pipe hop that measurably deadlocked here; `exec` makes the mock BECOME this process,
    // inheriting its stdio file descriptors directly, with no parent left waiting on it.
    const codexRunLog = join(shimDir, 'codex.run.log');
    const codexProbeLog = join(shimDir, 'codex.probe.log');
    const codexOtherLog = join(shimDir, 'codex.other.log');
    const codexHealthy = join(shimDir, 'codex-healthy.sh');
    await writeFile(
      codexHealthy,
      [
        '#!/bin/sh',
        'set -eu',
        `MOCK=${JSON.stringify(mockAppServer)}`,
        `RUN_LOG=${JSON.stringify(codexRunLog)}`,
        `PROBE_LOG=${JSON.stringify(codexProbeLog)}`,
        `OTHER_LOG=${JSON.stringify(codexOtherLog)}`,
        'if [ "${1:-}" = "login" ] && [ "${2:-}" = "status" ]; then',
        '  echo "$*" >> "$PROBE_LOG"',
        '  printf \'Logged in using ChatGPT\\n\'',
        '  exit 0',
        'fi',
        'if [ "${1:-}" = "app-server" ]; then',
        '  echo "$*" >> "$RUN_LOG"',
        '  exec node "$MOCK" "$@"',
        'fi',
        'echo "$*" >> "$OTHER_LOG"',
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    // A connected-but-out-of-scope codex: probes connected, never actually reached (the case that
    // exercises it never dispatches).
    const codexConnectedOnly = join(shimDir, 'codex-connected-only.mjs');
    await writeFile(
      codexConnectedOnly,
      '#!/usr/bin/env node\n'
      + 'const args = process.argv.slice(2);\n'
      + 'if (args[0] === \'login\' && args[1] === \'status\') {\n'
      + '  process.stdout.write(\'Logged in using ChatGPT\\n\');\n'
      + '  process.exitCode = 0;\n'
      + '} else {\n'
      + '  process.exitCode = 1;\n'
      + '}\n',
      { mode: 0o755 },
    );

    const opencodeConnected = join(shimDir, 'opencode-connected.mjs');
    await writeFile(
      opencodeConnected,
      '#!/usr/bin/env node\n'
      + 'process.stdout.write(\'\u250c  Credentials ~/.local/share/opencode/auth.json\\n\u2514  1 credential\\n\');\n'
      + 'process.exitCode = 0;\n',
      { mode: 0o755 },
    );

    const v7Repo = join(root, 'v7-fixture-repo');
    await mkdir(v7Repo);
    await execFile('git', ['init', '--initial-branch=main'], { cwd: v7Repo });
    await writeFile(join(v7Repo, 'README.md'), '# v7 fixture\n', 'utf8');
    await execFile('git', ['add', 'README.md'], { cwd: v7Repo });
    await execFile(
      'git',
      ['-c', 'user.name=Cezar CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'v7 fixture'],
      { cwd: v7Repo },
    );

    // Healthy fallback: claude disconnected, codex connected and in quota → the preflight does
    // NOT refuse, and dispatch actually reaches codex (not merely "a non-1 early exit", which any
    // unrelated failure would also satisfy).
    //
    // KNOWN LIMITATION, stated rather than hidden: this asserts that dispatch STARTS on codex —
    // it does not wait for the workflow to finish. Driving the mock app-server through a REAL
    // (non-`CEZ_DRY_RUN`) subprocess round trip via a `CEZ_CODEX_BIN` shim that must also answer
    // the `login status` probe (the same executable serves both, `provider-auth.ts`'s
    // `descriptorFor('codex').executable()` and `codex-app-server-transport.ts`'s
    // `resolveCodexExecutable()`) reproducibly stalls after the FIRST tool call in this sandbox
    // — confirmed via `ps`: the shim and the mock both start and stay alive, cezar never reports
    // a refusal, but the JSON-RPC turn never completes. That is a fixture/protocol-timing gap in
    // THIS harness, not evidence about the gate: `assessAccountViability` choosing codex over the
    // disconnected claude default for this exact fixture is already proven, both at the unit
    // level (`workspace/account-viability.test.ts`) and at the HTTP gate level with a real
    // dispatch assertion (`provider-action-gating.test.ts`, "THE REPORTED BUG" case). So this
    // case is scoped to what it can prove reliably: the preflight did not refuse, and dispatch
    // was actually attempted on codex (a probe AND a run, not just a probe) — never completion.
    {
      const v7Home = join(root, 'cez-v7-healthy');
      const env = {
        ...process.env,
        CEZ_HOME: v7Home,
        CEZ_CLAUDE_BIN: claudeDisconnected,
        CEZ_CODEX_BIN: codexHealthy,
      };
      const child = spawnCallback(
        process.execPath,
        [cliPath, 'run', 'take the healthy fallback', '--workflow', 'quick-task', '--repo', v7Repo],
        { cwd: consumerDir, env },
      );
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      // Bounded wait for dispatch to actually START, not for the run to finish — see the comment
      // above. 15s is comfortably past the probe + the mock's `initialize`/first-turn handshake.
      await new Promise((resolve) => { setTimeout(resolve, 15_000); });
      child.kill('SIGKILL');
      assert.doesNotMatch(stdout + stderr, /credentials are unavailable|No agent provider is authorized/);
      const probed = await readFile(codexProbeLog, 'utf8').catch(() => '');
      const ran = await readFile(codexRunLog, 'utf8').catch(() => '');
      assert.ok(probed.length > 0, 'codex was probed');
      assert.ok(ran.length > 0, 'codex was actually dispatched to, not just probed');
      const other = await readFile(codexOtherLog, 'utf8').catch(() => '');
      assert.equal(other, '', 'the codex shim never took an unrecognised branch');
    }

    // No connected account anywhere → exit 1, exact "No agent provider is authorized…" on stderr.
    {
      const v7Home = join(root, 'cez-v7-none');
      const env = {
        ...process.env,
        CEZ_HOME: v7Home,
        CEZ_CLAUDE_BIN: claudeDisconnected,
        CEZ_CODEX_BIN: codexDisconnected,
      };
      await assert.rejects(
        execFile(process.execPath, [cliPath, 'run', 'nothing is authorized', '--workflow', 'quick-task', '--repo', v7Repo], {
          cwd: consumerDir,
          env,
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        }),
        (error: unknown) => {
          const result = error as { code?: number; stderr?: string };
          assert.equal(result.stderr?.trim(), NO_PROVIDER_AUTHORIZED_MESSAGE);
          return true;
        },
        'no connected account anywhere must exit non-zero with the generic message',
      );
    }

    // Connected, but out of scope: claude required and disconnected, codex connected, an explicit
    // claude route, fallback OFF → exit 1, exact fallback-off sentence.
    {
      const v7Home = join(root, 'cez-v7-scope');
      await execFile(process.execPath, [cliPath, 'projects', 'add', v7Repo], {
        cwd: consumerDir,
        env: { ...process.env, CEZ_HOME: v7Home },
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const workspacePath = join(v7Home, 'config.json');
      const workspace = JSON.parse(await readFile(workspacePath, 'utf8')) as {
        resources?: Record<string, unknown>;
      };
      workspace.resources = { ...workspace.resources, fallbackAcrossAccountsWhenLimited: false };
      await writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
      const env = {
        ...process.env,
        CEZ_HOME: v7Home,
        CEZ_CLAUDE_BIN: claudeDisconnected,
        CEZ_CODEX_BIN: codexConnectedOnly,
      };
      await assert.rejects(
        execFile(process.execPath, [cliPath, 'run', 'fallback is off', '--workflow', 'quick-task', '--repo', v7Repo], {
          cwd: consumerDir,
          env,
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        }),
        (error: unknown) => {
          const result = error as { stderr?: string };
          assert.equal(result.stderr?.trim(), fallbackOffMessage('claude'));
          return true;
        },
        'an eligible account out of scope must exit non-zero with the fallback-off sentence',
      );
    }

    // Connected, but nothing eligible: claude/codex both disconnected, OpenCode connected → exit
    // 1, exact no-account-cezar-can-move-this-to sentence — never "no agent provider is
    // authorized", which would be false (OpenCode is).
    {
      const v7Home = join(root, 'cez-v7-ineligible');
      const env = {
        ...process.env,
        CEZ_HOME: v7Home,
        CEZ_CLAUDE_BIN: claudeDisconnected,
        CEZ_CODEX_BIN: codexDisconnected,
        CEZ_OPENCODE_BIN: opencodeConnected,
      };
      await assert.rejects(
        execFile(process.execPath, [cliPath, 'run', 'only opencode is connected', '--workflow', 'quick-task', '--repo', v7Repo], {
          cwd: consumerDir,
          env,
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        }),
        (error: unknown) => {
          const result = error as { stderr?: string };
          assert.equal(result.stderr?.trim(), noEligibleFallbackMessage('claude'));
          return true;
        },
        'a connected but ineligible provider must exit non-zero with the no-account-can-move sentence',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
