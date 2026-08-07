import { createHash } from 'node:crypto';
import { hasPasswordlessSudo, shared, shquote, StepAborted, sudoStep, verifyCommand } from '../../steps.ts';
import type { InstallContext, InstallStep, StepArtifact } from '../../types.ts';

/**
 * D4/D10 unit 2 — the unix user + `CEZ_HOME` that make one org's cezar process
 * a real OS-level boundary, not an app-level check. Spec:
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, D4 ("isolation is a
 * process per org") and D10's ownership map (unit 2).
 *
 * Every command here is a STRING, built and returned, never executed by this
 * module against the machine it runs on — the caller (the `hetzner` platform
 * strategy, unit 6) threads it through `sudoStep`, which is the codebase's one
 * seam for "show the operator a privileged command, let them run it via sudo
 * or paste it as root, then prove it took effect." Nothing here calls
 * `useradd`/`chown`/`chmod`/`git` directly; `ctx.runner` is the only thing
 * that can, and it is real only when `server-install` actually runs on a
 * target host.
 *
 * The isolation this buys, concretely: `chmod 0700` on the org's home makes
 * every path under it — including a not-yet-created `.cezar` — unreadable to
 * every other uid on the box. `stat(2)` needs execute (search) permission on
 * each ANCESTOR directory (`/`, `/home`, both world-searchable by default),
 * but needs nothing on the target itself, so `test -d`/`stat` on a locked-down
 * home still resolves for an unprivileged caller — only its CONTENTS become
 * unreachable. That is why `check()` below can probe the lock state without
 * root, while reading anything *inside* the home (the git-safe-directory
 * verify) cannot and has to borrow root the same way the ufw sub-step in
 * `ubuntu-vps.ts` already does.
 *
 * Reused verbatim by (not yet built) units 3/4/6: `orgUnixUsername`,
 * `orgHomeDir`, `orgCezHome` are the ONE place this derivation lives —
 * `systemd-unit.ts` needs `orgUnixUsername`/`orgHomeDir` for `User=`/`%h`,
 * and any future project-registration flow needs `trustProjectRootCommand`
 * for a root registered after this step already ran. Re-deriving any of these
 * elsewhere is exactly the "two-literals-hand-kept-in-sync" drift D3/D10's own
 * history in this spec already names as a real failure mode (`server.ts`'s
 * `LOCAL_PRINCIPAL` vs. `auth/principal.ts`'s `LOCAL_IDENTITY`) — import, do
 * not recompute.
 *
 * Deliberately NOT done here, and why:
 *  - No `Environment=CEZ_HOME=…` is emitted or needed. `/home/<user>/.cezar`
 *    IS `cezarHomeDir()`'s own default (`paths.ts`: `homedir()/.cezar`) —
 *    once the org's systemd unit sets `User=<user>` (unit 3), systemd
 *    populates `$HOME` from NSS for that unit automatically (systemd.exec(5):
 *    "$HOME … set based on the user database entry … unless already set"),
 *    so `os.homedir()` resolves correctly with zero override. Provisioning
 *    the home at the exact path cezar already defaults to is what makes that
 *    true — moving it would force unit 3 to add the override this note says
 *    it doesn't need.
 *  - No group is added beyond the user's own private group (`--user-group`).
 *    In particular never `sudo`/`adm`/`docker` — an org process gets no
 *    privilege escalation path beyond what D4 already grants it.
 *  - No password is set. `useradd` with no `-p` leaves the account locked for
 *    password auth; the only entry point is `sudo -u <user> -H …`, run by an
 *    operator who already has sudo on the box.
 *  - The unix user is a `shared` artifact, never auto-removed on uninstall —
 *    see `orgUserProvisioningStep`'s `undo`.
 */

// ---- org slug -> unix identity ---------------------------------------------

/**
 * Mirrors `auth/types.ts`'s `slugSchema` (DNS-label rules) exactly, duplicated
 * rather than imported: `auth/types.ts` is owned by units 1/5 and may be
 * mid-edit in the same session (D10's ownership map keeps units to disjoint
 * file sets on purpose). A slug this module builds a shell command from is
 * validated here regardless of what validated it upstream — belt and
 * suspenders for a string that ends up inside `useradd`/`chown` argv.
 */
const ORG_SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ORG_SLUG_MAX_LEN = 63;

export const ORG_USER_PREFIX = 'cez-';
/** Historical `utmp` `ut_user[32]` limit; `useradd` will create a longer name
 *  but tools built on utmp (`who`, `w`) truncate it, so stay under it. */
const MAX_UNIX_USERNAME_LEN = 32;

/**
 * Deterministic unix username for an org. Throws `StepAborted` synchronously
 * on an invalid slug — call sites that build an `InstallStep[]` (i.e.
 * `orgUserProvisioningStep`) should let this surface during `preflight()`
 * rather than mid-`steps()`, so a bad `--org-slug` never gets as far as
 * showing the operator a privileged command.
 */
export function orgUnixUsername(orgSlug: string): string {
  const slug = orgSlug.trim();
  if (!ORG_SLUG_RE.test(slug) || slug.length > ORG_SLUG_MAX_LEN) {
    throw new StepAborted(
      `"${orgSlug}" is not a valid org slug (lowercase, hyphen-safe, DNS-label rules) — refusing to derive a unix username from it`,
    );
  }
  const full = `${ORG_USER_PREFIX}${slug}`;
  if (full.length <= MAX_UNIX_USERNAME_LEN) return full;
  // Too long for a portable username. Truncate and append a short hash of the
  // FULL slug so two slugs that only differ after the truncation point never
  // collide on one username.
  const hash = createHash('sha256').update(slug).digest('hex').slice(0, 8);
  const keep = MAX_UNIX_USERNAME_LEN - ORG_USER_PREFIX.length - 1 - hash.length; // -1 for the '-' separator
  return `${ORG_USER_PREFIX}${slug.slice(0, keep)}-${hash}`;
}

/** `/home/<username>` — deliberately not `%h`/`$HOME`-relative; systemd needs
 *  a literal path for `WorkingDirectory=`/home-lockdown verification. */
export function orgHomeDir(username: string): string {
  return `/home/${username}`;
}

/** `<home>/.cezar` — the exact path `cezarHomeDir()` (`paths.ts`) already
 *  defaults to once `$HOME` resolves here. See the module docblock. */
export function orgCezHome(username: string): string {
  return `${orgHomeDir(username)}/.cezar`;
}

/**
 * This org's OWN project root — the systemd unit's `WorkingDirectory=`, and therefore the
 * directory `cezar serve` opens its `RunStore` in (`src/index.ts`: `openStore(repoRoot)` →
 * `<repoRoot>/.ai/cezar`) and auto-registers as its boot project.
 *
 * **ADDED 2026-08-07 at the phase 6/7 repair stage, and it is the phase-6 verification row.**
 * Every org unit used to carry `WorkingDirectory=<the operator's own checkout>` — `ctx.repoRoot`,
 * the git root of wherever `server-install` happened to be run — and `systemd-unit.ts` stated it
 * outright: "the same value on every org's unit on one host". But run history, knowledge,
 * automations and worktrees are PROJECT-local (`server/project-context.ts`:
 * `join(project.root, '.ai/cezar')`), not `CEZ_HOME`-local, so two orgs with two unix users and
 * two `CEZ_HOME`s still both opened `<operator checkout>/.ai/cezar/runs.json` — which `RunStore`
 * writes with a debounced whole-file tmp+rename and NO lease (spec Problem §4). That is verbatim
 * the "two processes over one `.ai/cezar` is silent run-history loss" D4's hard constraint exists
 * to prevent, arriving through the boot project, which never passes through `registerFolder`'s
 * claim check at all. Phase 6's row reads "two orgs ⇒ two unix users, two `CEZ_HOME`s, **no shared
 * path**; org A cannot read org B's runs", and only the first two clauses held.
 *
 * Inside the `0700` home on purpose: `stat(2)` on the home still resolves for another uid (see
 * the module docblock) but nothing under it opens, so `sudo -u cez-b cat <org A's runs.json>`
 * fails with EACCES at the OS, not at an app check. Deliberately NOT a git repo — cezar runs
 * fine in a plain directory (`getRepoInfo` answers `null`, `repoRoot` falls back to the cwd) and
 * an org's real repositories are registered afterwards, through the cockpit, under `browseRoot`
 * (which defaults to `~`, i.e. this same locked-down home).
 */
export function orgProjectRoot(username: string): string {
  return `${orgHomeDir(username)}/workspace`;
}

/** Create + lock this org's project root. `install -d` is idempotent and sets ownership/mode
 *  atomically, so a re-run never widens a permission window (same shape as
 *  `createCezHomeCommand`). */
export function createOrgProjectRootCommand(username: string): string {
  return `install -d -m 0700 -o ${username} -g ${username} ${orgProjectRoot(username)}`;
}

// ---- pure command generators ------------------------------------------------

/**
 * Create the org's unix user (guarded — safe to re-run) and lock its home to
 * `0700`. The lock is the actual isolation boundary; `useradd -m`'s own
 * default mode depends on distro `UMASK`/`login.defs` and is not trusted here.
 */
export function createOrgUserCommand(username: string, orgSlug: string): string {
  const home = orgHomeDir(username);
  const comment = shquote(`cezar org: ${orgSlug}`);
  return [
    `(id -u ${username} >/dev/null 2>&1 || useradd --create-home --home-dir ${home} --user-group --shell /bin/bash --comment ${comment} ${username})`,
    `chown ${username}:${username} ${home}`,
    `chmod 0700 ${home}`,
  ].join(' && ');
}

/** `stat -c '%a %U'` on `path` — no root needed (see module docblock). */
function statOwnerModeCmd(path: string): string {
  return `stat -c '%a %U' ${shquote(path)} 2>/dev/null`;
}

/** True when `path` is `0700`, owned by `username`. */
async function isLockedTo(ctx: InstallContext, path: string, username: string): Promise<boolean> {
  return verifyCommand(ctx, 'sh', ['-c', statOwnerModeCmd(path)], (r) => r.stdout.trim() === `700 ${username}`);
}

/** Create + lock this org's `CEZ_HOME`. `install -d` is idempotent and sets
 *  ownership/mode atomically, so a re-run never widens a permission window. */
export function createCezHomeCommand(username: string): string {
  return `install -d -m 0700 -o ${username} -g ${username} ${orgCezHome(username)}`;
}

/**
 * Trust `repoRoot` for `username`'s git worktree writes. `git-worktree.ts`
 * creates worktrees INSIDE the project root
 * (`join(canonicalPath(repoRoot), '.ai/cezar/worktrees', runId)`), and that
 * root is very unlikely to be owned by the org's own uid (it is normally
 * whoever checked the repo out) — git's "detected dubious ownership" guard
 * then refuses every worktree operation unless the owning user's
 * `safe.directory` list names it. Idempotent by construction (guard-then-add):
 * a bare `--add` on every re-run/redeploy would otherwise grow a duplicate
 * entry each time.
 */
export function trustProjectRootCommand(username: string, repoRoot: string): string {
  const root = shquote(repoRoot);
  return (
    `sudo -u ${username} -H git config --global --get-all safe.directory 2>/dev/null | grep -qxF ${root} ` +
    `|| sudo -u ${username} -H git config --global --add safe.directory ${root}`
  );
}

/** Root is required to read INSIDE the org's `0700` home (the operator's own
 *  uid cannot), mirroring the ufw sub-step's identical root-or-trust fallback
 *  in `ubuntu-vps.ts#nginxProxyStep`. */
async function verifyProjectRootTrusted(ctx: InstallContext, username: string, repoRoot: string): Promise<boolean> {
  if (ctx.dryRun) return false;
  const probe = `sudo -u ${username} -H git config --global --get-all safe.directory 2>/dev/null | grep -qxF ${shquote(repoRoot)}`;
  if (await hasPasswordlessSudo(ctx)) {
    return (await ctx.runner.capture('sudo', ['-n', 'bash', '-lc', probe])).code === 0;
  }
  // No root and no human in the loop (`--yes`): nobody ran the command, so it
  // cannot have verified itself.
  if (ctx.assumeYes) return false;
  ctx.ui.warn(`Cannot read ${username}'s git config without root — trusting the command you just ran.`);
  return true;
}

export interface AgentLoginInstruction {
  agent: 'claude' | 'codex' | 'opencode';
  /** Run on the host, as the operator — `sudo -u` drops into the org uid. */
  command: string;
}

/**
 * The command that gives each agent CLI its OWN credentials under this org's
 * uid. Mirrors `core/provider-auth.ts`'s `DESCRIPTORS[].loginArgs`
 * (`claude` → `auth login`, `codex` → `login`, `opencode` → `auth login`) —
 * duplicated with a note rather than imported, the same allowance D10's
 * ownership map gives unit 3 for `ubuntu-vps.ts`'s `sysd()`: that module's
 * `DESCRIPTORS` isn't exported, and pulling in `provider-auth.ts`'s
 * `execFile`-based runtime for three literal strings would be the wrong
 * trade. If `loginArgs` ever changes there, it must change here too.
 *
 * This exists because of a real gap recon:isolation found: under `User=<org
 * user>` the process's `$HOME` (and so `CLAUDE_CONFIG_DIR`/`CODEX_HOME`'s
 * *default*, and OpenCode's credential db, which has NO override variable at
 * all — `core/agent-profiles.ts`'s `PROFILE_ENV_VAR.opencode === null`) all
 * point at the org's own home. But nothing signs the agent CLIs in there
 * automatically — login is inherently interactive (OAuth/device-code flows),
 * and the cockpit's own in-app login handoff
 * (`server.ts`'s `capabilities().localHandoff` check,
 * `core/provider-auth.ts#loginCommand`) has no seam for a `sudo -u … -H`
 * prefix, so an operator who follows THAT instruction signs into their OWN
 * `~/.claude`, not the org's. These commands are the operator-run alternative
 * until that seam exists.
 */
export function agentCredentialLoginCommands(username: string): AgentLoginInstruction[] {
  return [
    { agent: 'claude', command: `sudo -u ${username} -H claude auth login` },
    { agent: 'codex', command: `sudo -u ${username} -H codex login` },
    { agent: 'opencode', command: `sudo -u ${username} -H opencode auth login` },
  ];
}

// ---- the InstallStep --------------------------------------------------------

/**
 * The composed step: create + lock the org's unix user and `CEZ_HOME`, trust
 * its OWN project root (`orgProjectRoot`, never the operator's checkout — see that function's
 * doc comment), trust that root for its git worktree writes, and print the agent-login
 * commands (interactive; cannot be scripted). Intended to run FIRST in the
 * `hetzner` platform's step list — unit 3 (systemd unit) and unit 4 (nginx)
 * both need `orgUnixUsername(orgSlug)`/`orgHomeDir(...)` already resolved.
 *
 * Throws `StepAborted` synchronously (via `orgUnixUsername`) if `orgSlug` is
 * invalid — see that function's doc comment for why the caller should invoke
 * this from `preflight()`, or otherwise before any step is shown.
 */
export function orgUserProvisioningStep(orgSlug: string): InstallStep {
  const username = orgUnixUsername(orgSlug);
  const home = orgHomeDir(username);
  const cezHome = orgCezHome(username);
  const projectRoot = orgProjectRoot(username);

  return {
    id: 'org-user',
    title: `Dedicated unix user + CEZ_HOME + project root for org "${orgSlug}" (D4 process isolation)`,
    async check(ctx) {
      if (ctx.dryRun) return false;
      const userExists = await verifyCommand(ctx, 'id', ['-u', username]);
      const homeLocked = await isLockedTo(ctx, home, username);
      const cezHomeOk = await verifyCommand(ctx, 'test', ['-d', cezHome]);
      const projectRootOk = await verifyCommand(ctx, 'test', ['-d', projectRoot]);
      return userExists && homeLocked && cezHomeOk && projectRootOk;
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      await sudoStep(ctx, {
        description:
          `Create the dedicated unix user "${username}" for org "${orgSlug}" and lock its home to 0700 — ` +
          `this uid boundary is what makes cross-org reads impossible at the filesystem level, not merely inconvenient (D4).`,
        command: createOrgUserCommand(username, orgSlug),
        verify: (c) => isLockedTo(c, home, username),
      });

      await sudoStep(ctx, {
        description:
          `Create this org's CEZ_HOME (${cezHome}) — the systemd unit runs as ${username}, so this is where ` +
          `identity, run history and knowledge for this org live, and nowhere another org's process can see.`,
        command: createCezHomeCommand(username),
        verify: (c) => verifyCommand(c, 'test', ['-d', cezHome]),
      });

      await sudoStep(ctx, {
        description:
          `Create this org's OWN project root (${projectRoot}) — the systemd unit's WorkingDirectory, and where ` +
          `run history, knowledge and task worktrees live (<root>/.ai/cezar). Inside the 0700 home, so no other ` +
          `org's uid can read it: this is what "org A cannot read org B's runs" actually means (D4).`,
        command: createOrgProjectRootCommand(username),
        verify: (c) => verifyCommand(c, 'test', ['-d', projectRoot]),
      });

      await sudoStep(ctx, {
        description:
          `Trust ${projectRoot} for ${username}'s git worktree writes — git refuses to operate in a repo it ` +
          `does not own by default, and worktrees are created inside the project root (git-worktree.ts). ` +
          `Belt-and-braces here (the org uid owns this path), and load-bearing for any repository later ` +
          `cloned into it by root.`,
        command: trustProjectRootCommand(username, projectRoot),
        verify: (c) => verifyProjectRootTrusted(c, username, projectRoot),
      });

      const logins = agentCredentialLoginCommands(username);
      ctx.ui.note(
        [
          `${username} needs its OWN agent CLI credentials — signing in as yourself does not reach it.`,
          `Claude Code and Codex COULD relocate under one shared uid (CLAUDE_CONFIG_DIR/CODEX_HOME), but`,
          `OpenCode has no such variable — its credentials live at ~/.local/share/opencode/opencode.db,`,
          `so this separate $HOME is the ONLY way to give it a separate identity. Run these on the host,`,
          `as yourself (sudo drops into the org user):`,
          '',
          ...logins.map((l) => `  ${l.command}`),
          '',
          `Remember D4's other half: everyone who can run code as ${username} can act as every other`,
          `member of org "${orgSlug}". Invite accordingly.`,
        ].join('\n'),
        `Agent credentials for org "${orgSlug}"`,
      );

      const artifacts: StepArtifact[] = [
        shared('unix-user', {
          name: username,
          path: home,
          removeHint: `sudo userdel -r ${username}   # deletes the home dir — identity, run history, knowledge and agent credentials for this org go with it`,
        }),
      ];
      return { artifacts };
    },
    async undo(ctx, created) {
      // `shared`, like nginx/certbot elsewhere in this codebase: this is real,
      // possibly-irreplaceable org state (agent credentials, run history,
      // knowledge). Uninstall lists the removal command; it never runs it.
      const user = (created?.artifacts ?? []).find((a) => a.type === 'unix-user');
      if (!user) return;
      ctx.ui.note(
        `The dedicated unix user and its home were left in place — deleting it destroys this org's identity, ` +
          `run history, knowledge and agent credentials.\nRemove it yourself if you're sure:\n${user.removeHint ?? ''}`,
        'org user',
      );
    },
  };
}
