import { join } from 'node:path';
import { cezarHomeDir } from '../paths.ts';

/**
 * Supervisor-owned paths (D4/D10, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`).
 * Fill unit 1's own file — `../paths.ts` (the pre-existing, cross-process helper module) is
 * imported here, never edited: `org-process-registry.ts`'s own doc comment is explicit that this
 * unit "adds one new `paths.ts`-style function ... rather than overloading" `identityDir()`.
 *
 * **Which `CEZ_HOME`.** `cezarHomeDir()` already reads `env.CEZ_HOME` per call — there is nothing
 * supervisor-specific to add there. What makes this the SUPERVISOR's home rather than an org's or
 * the operator's own is purely which value `CEZ_HOME` carries in *this* process's environment
 * (D10: "boots with its OWN `CEZ_HOME`, never equal to any org's, and never the operator's real
 * `~/.cezar`") — a fact the systemd unit that starts `cezar supervisor` is responsible for, not
 * this module.
 *
 * **Why a new directory name, not `identityDir()`'s `identity/`.** This directory holds
 * infrastructure secrets (`OrgProcessRecord#supervisorSecret`, `unixUser`, `cezHome`,
 * `loopbackPort`) — a different kind of state than `identity/`'s orgs/teams/users/sessions, even
 * though both live under the same supervisor `CEZ_HOME` and both are supervisor-only per D10 ("the
 * supervisor terminates auth and is the only process that ever opens
 * `<CEZ_HOME>/identity/*.json`"; this is the process-infrastructure counterpart). Naming it
 * `identity` would be a false trail for the next reader.
 */
export function orgProcessRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'supervisor');
}
