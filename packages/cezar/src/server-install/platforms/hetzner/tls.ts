import { CANCEL, type InstallContext, type InstallStep, type StepArtifact } from '../../types.ts';
import { HOSTNAME_RE, StepAborted, StepCancelled, owned, shared, shquote, sudoStep, verifyCommand } from '../../steps.ts';

/**
 * Certificate issuance and renewal for the `hetzner` platform (D4/D9/D10,
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`). Fill unit 7 in D10's ownership map.
 *
 * **Unlike ubuntu-vps, TLS here is not optional.** `ubuntu-vps.ts`'s `sslStep` can be skipped
 * because that platform's perimeter is an nginx `auth_basic` challenge — no cookie, nothing a
 * plain-HTTP connection breaks. hetzner replaces that with a real session: `auth/session.ts`'s
 * cookie is serialized with `Secure` UNCONDITIONALLY (`logoutCookie`/`serializeSessionCookie`,
 * D6) — never gated on the request's own scheme — so a plain-HTTP hetzner deployment would set
 * a cookie the browser refuses to send back on the very next request. Every login would fail
 * silently, one request after it appeared to succeed. There is therefore no `optional: true`
 * anywhere in this file.
 *
 * **Why this file exists rather than three more lines in `ubuntu-vps.ts`.** D9: `redirect_uri`
 * must be an exact registered match, and it is built once, at boot, from `CEZ_PUBLIC_URL`
 * (`auth/oidc.ts#resolveOidcConfig`, "call this ONCE at boot, never per request" — a per-request
 * `Host` header is attacker-controlled). So the domain a certificate is issued for and the
 * `CEZ_PUBLIC_URL` the supervisor's unit boots with are two facts that MUST agree, and nothing
 * before this pass made that true by construction. A TLS reconfiguration that changes the
 * supervisor's login host — a real operator action, not a mistake — silently breaks every login
 * until someone remembers, separately, to update `CEZ_PUBLIC_URL` and restart the supervisor.
 * `describePublicUrlDrift` below is what turns that "silently" into "loudly, with the exact fix".
 *
 * **SAFETY (this module never touches a real machine).** Every export here is a pure generator
 * — a command string, a config file's content, or an `InstallStep` that hands those strings to
 * `ctx.runner`/`sudoStep` exactly the way `ubuntu-vps.ts`'s `sslStep` does. Nothing here spawns a
 * process, opens a socket, or issues a real certificate; `createTlsStep`'s tests drive it with a
 * scripted fake `Runner`, the same discipline `ubuntu-vps.test.ts` uses for `sslStep`.
 *
 * **Duplication note (D10's ownership map, row 7):** the `certbot --nginx -d <domain>` shape and
 * the `grep -qs ssl_certificate <vhost>` verify oracle below are copied in miniature from
 * `ubuntu-vps.ts`'s `sslStep` rather than imported — that file doesn't export either, and
 * invariant 6 (upgrade safety) forbids editing `ubuntu-vps.ts#systemdUnit`/its sibling steps from
 * this pass to add an export. The verify oracle's own reasoning is worth restating: reading
 * `/etc/letsencrypt/live` needs root (`0700`), but the vhost certbot edits is nginx-readable
 * (`0644`), so grepping the vhost proves the same fact without a privileged read.
 */

// ---- domain / email validation --------------------------------------------------------------

/** Local duplicate of `ubuntu-vps.ts`'s `EMAIL_RE` (not exported there either). */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---- the CEZ_PUBLIC_URL <-> domain contract (D9) --------------------------------------------

/**
 * The public origin implied by a TLS-fronted hostname — the ONE place this computation happens,
 * so nothing else in the 8-unit ownership map hand-writes `https://${domain}` a second time and
 * lets it drift from what `CEZ_PUBLIC_URL` must equal (the exact "two-literals-hand-kept-in-sync"
 * failure mode D3's history already names once in this spec — `server.ts`'s `LOCAL_PRINCIPAL` vs.
 * `auth/principal.ts`'s `LOCAL_IDENTITY`).
 */
export function publicUrlForDomain(domain: string): string {
  return `https://${domain.trim()}`;
}

/**
 * `null` when there is nothing to warn about: no prior `CEZ_PUBLIC_URL`-equivalent recorded, or
 * it already matches. Otherwise the exact, actionable warning `createTlsStep` surfaces — naming
 * both the stale and the correct value and the consequence of not fixing it, per D1's own
 * doctrine applied here: the tool cannot silently reconcile a running supervisor's env for the
 * caller (this module never touches the supervisor's unit — that is Fill units 1/3), so the only
 * thing it can do is make the mismatch impossible to miss.
 */
export function describePublicUrlDrift(previousPublicUrl: string | undefined, domain: string): string | null {
  if (!previousPublicUrl) return null;
  const next = publicUrlForDomain(domain);
  if (previousPublicUrl === next) return null;
  return (
    `The public origin for this instance is changing from ${previousPublicUrl} to ${next}. ` +
    `CEZ_PUBLIC_URL on the supervisor's own systemd unit MUST be updated to "${next}" and the ` +
    `supervisor service restarted before anyone can log in again — resolveOidcConfig() reads it ` +
    `exactly once, at boot (D9), so a stale value keeps building a redirect_uri that no longer ` +
    `matches what the IdP has registered and every sign-in attempt fails until it is corrected. ` +
    `This installer does not manage the supervisor's unit file — that is a separate step.`
  );
}

// ---- certbot command generators ---------------------------------------------------------------

/** Same install line `ubuntu-vps.ts`'s `sslStep` uses. */
export const CERTBOT_INSTALL_COMMAND = 'apt-get install -y certbot python3-certbot-nginx';

/**
 * Obtain + install a certificate for one hostname via the nginx plugin, which locates the
 * ALREADY-EXISTING vhost matching `server_name <domain>` and edits it in place — the same
 * ordering `ubuntu-vps.ts`'s `sslStep` depends on (the vhost must name this domain before this
 * command runs; `nginx.ts`, Fill unit 4, is what writes it). Reused verbatim for every hostname
 * hetzner ever provisions: the supervisor's own login host up front, then one more per org.
 */
export function certbotIssueCommand(domain: string, email: string): string {
  return `certbot --nginx -d ${shquote(domain.trim())} --non-interactive --agree-tos -m ${shquote(email.trim())} --redirect`;
}

/**
 * A dry-run of this lineage's renewal. Never renews, never touches the live cert, makes no
 * network request from THIS module — like every other string here, it is only ever executed by
 * the caller's own `ctx.runner`. Run once right after issuance so a renewal misconfiguration (a
 * plugin dependency missing, a broken vhost edit) is caught while an operator is still watching
 * the terminal, not three months later when the real certificate silently expires.
 */
export function certbotRenewalDryRunCommand(domain: string): string {
  return `certbot renew --cert-name ${shquote(domain.trim())} --dry-run`;
}

/** True once the vhost at `vhostPath` carries certbot's TLS edit — see the module doc comment
 *  for why this file, not `/etc/letsencrypt/live`, is the oracle an unprivileged read can use. */
export async function verifyTlsInstalled(ctx: InstallContext, vhostPath: string): Promise<boolean> {
  return verifyCommand(ctx, 'sh', ['-c', `grep -qs ssl_certificate ${shquote(vhostPath)}`]);
}

// ---- the renewal <-> CEZ_PUBLIC_URL guard hook -------------------------------------------------

/** Where the guard hook is written. Fixed (not per-domain): certbot runs every script under this
 *  directory after EVERY successful renewal on the host, for every lineage, so one script that
 *  filters on `$RENEWED_DOMAINS` covers every hostname hetzner ever provisions — reprovisioning a
 *  second org overwrites the same file with an updated case arm rather than adding a second one,
 *  which would leave a stale arm behind after `server-uninstall`. */
export const RENEWAL_GUARD_HOOK_PATH = '/etc/letsencrypt/renewal-hooks/deploy/cezar-public-url-guard.sh';

/**
 * A certbot deploy-hook that turns a SILENT `CEZ_PUBLIC_URL` drift into a LOUD one. Routine
 * renewal never changes a domain — the lineage is keyed on it — so this can never itself cause
 * the drift; what it catches is a manual edit that happened after the fact (someone changed the
 * supervisor's env without also re-running TLS provisioning). It never edits anything and never
 * fails the renewal on a mismatch: a hook that aborts risks leaving a certificate to expire
 * unrenewed, which is strictly worse than a wrong `CEZ_PUBLIC_URL`. `publicUrlConfigFile` is
 * whatever file the supervisor's unit sources `CEZ_PUBLIC_URL` from — its own unit file's
 * `Environment=` line (D10's `Environment=` is fine for this: unlike `CEZ_SUPERVISOR_SECRET` it
 * is not a secret, so it need not go through `EnvironmentFile=`) or a separate env file, whichever
 * Fill units 1/3 choose. The check is a plain substring grep so it matches either shape.
 */
export function renewalGuardHookScript(domain: string, publicUrlConfigFile: string): string {
  const expected = publicUrlForDomain(domain.trim());
  return `#!/bin/sh
# Managed by cezar server-install — do not edit by hand.
# certbot runs this after EVERY renewal on the host; only act on ${domain}'s.
case ",$RENEWED_DOMAINS," in
  *,${domain.trim()},*) ;;
  *) exit 0 ;;
esac
if [ -f ${shquote(publicUrlConfigFile)} ] && ! grep -qF ${shquote(`CEZ_PUBLIC_URL=${expected}`)} ${shquote(publicUrlConfigFile)}; then
  logger -t cezar-tls "WARNING: ${domain.trim()} renewed but ${publicUrlConfigFile} no longer sets CEZ_PUBLIC_URL=${expected} -- OIDC logins will fail until it is corrected and the supervisor is restarted."
fi
exit 0
`;
}

/** A short duplicate of `ubuntu-vps.ts`'s `writeRootFileCmd` (not exported there): base64 so a
 *  copy-paste of the command survives newlines/quoting untouched. */
function writeRootFileCommand(path: string, content: string, extra = ''): string {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  return `install -d -m 0755 ${shquote(dir)} && printf %s ${shquote(b64)} | base64 --decode > ${shquote(path)}${extra ? ` && ${extra}` : ''}`;
}

// ---- the step -----------------------------------------------------------------------------------

export interface TlsStepOptions {
  /** Hostname to certify — the supervisor's own login host, or one org's hostname. Always known
   *  up front for hetzner (D10's `--domain <org-hostname> --org-slug <slug>`), unlike
   *  `ubuntu-vps.ts`'s optional default-instance domain prompt. */
  domain: string;
  /** Email for Let's Encrypt renewal notices. Prompted interactively when absent — pass one
   *  straight through from a CLI flag/env var the caller owns to skip the prompt. */
  email?: string;
  /** Absolute path to the nginx vhost ALREADY serving `domain` in plain HTTP (written by
   *  `nginx.ts`, Fill unit 4, before this step runs — the ordering `ubuntu-vps.ts`'s `sslStep`
   *  depends on: certbot's `--nginx` plugin locates a vhost by matching `server_name`). */
  vhostPath: string;
  /** `'supervisor'`: this domain is the ONE `CEZ_PUBLIC_URL`/D9's `redirect_uri` is built from —
   *  a change here is surfaced via `describePublicUrlDrift` and (when `publicUrlConfigFile` is
   *  given) guarded on every future renewal. `'org'`: display-only. Org processes never run OIDC
   *  (D10: they trust a forwarded, signed principal instead), so a hostname change there has no
   *  `CEZ_PUBLIC_URL` consequence. */
  role: 'supervisor' | 'org';
  /** The file the supervisor's unit reads `CEZ_PUBLIC_URL` from (see `renewalGuardHookScript`).
   *  Ignored for `role: 'org'`. Absent ⇒ no renewal guard hook is installed — the caller hasn't
   *  wired the path yet, which is fine; issuance still succeeds. */
  publicUrlConfigFile?: string;
}

/**
 * Build the TLS step for one hostname. `id` is fixed (`'tls'`) rather than domain-suffixed like
 * `ubuntu-vps.ts`'s multi-instance artifact paths — each hetzner provisioning run already gets
 * its own `server.json` instance record (Fill unit 6's `--domain`/`--org-slug` plumbing), so the
 * step id never needs to disambiguate within one run's own step ledger.
 */
export function createTlsStep(opts: TlsStepOptions): InstallStep {
  const domain = opts.domain.trim();
  return {
    id: 'tls',
    title: `Domain + TLS (Let's Encrypt) for ${domain}`,
    // NOT optional — see the module doc comment (the session cookie is unconditionally Secure).
    async check(ctx) {
      return verifyTlsInstalled(ctx, opts.vhostPath);
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      if (!HOSTNAME_RE.test(domain)) throw new StepAborted(`"${domain}" is not a valid hostname`);

      let email = opts.email?.trim();
      if (!email) {
        const answer = await ctx.ui.text({
          message: `Email for Let's Encrypt renewal notices (${domain})`,
          placeholder: 'you@example.com',
          validate: (v) => (EMAIL_RE.test(v.trim()) ? undefined : 'enter a valid email'),
        });
        if (answer === CANCEL) throw new StepCancelled();
        email = String(answer).trim();
      }
      if (!EMAIL_RE.test(email)) throw new StepAborted(`"${email}" is not a valid email`);

      const certbotWasPresent = await verifyCommand(ctx, 'certbot', ['--version']);
      await sudoStep(ctx, {
        description: 'Install certbot + its nginx plugin.',
        command: CERTBOT_INSTALL_COMMAND,
        verify: (c) => verifyCommand(c, 'certbot', ['--version']),
      });

      await sudoStep(ctx, {
        description: `Obtain and install a Let's Encrypt certificate for ${domain}.`,
        command: certbotIssueCommand(domain, email),
        skippable: true,
        skipHint: `run later: sudo certbot --nginx -d ${domain}`,
        verify: (c) => verifyTlsInstalled(c, opts.vhostPath),
      });

      // Best-effort proof that the SAME lineage renews cleanly. Never fails the step — the
      // certificate just issued is real and serving regardless of whether a dry-run three
      // months early succeeds; it is a warning for the operator to act on, not a gate.
      if (!ctx.dryRun) {
        const dryRun = await ctx.runner.capture('bash', ['-lc', certbotRenewalDryRunCommand(domain)]);
        if (dryRun.code !== 0) {
          ctx.ui.warn(
            `certbot's renewal dry-run for ${domain} did not succeed — the certificate issued just now is ` +
              `fine, but check this before it needs to renew:\n  sudo ${certbotRenewalDryRunCommand(domain)}`,
          );
        }
      }

      const artifacts: StepArtifact[] = [
        shared('cert', { name: domain, removeHint: `sudo certbot delete --cert-name ${domain}` }),
      ];
      if (!certbotWasPresent) {
        artifacts.push(
          shared('package', {
            name: 'certbot + python3-certbot-nginx',
            removeHint: 'sudo apt-get remove -y certbot python3-certbot-nginx',
          }),
        );
      }

      if (opts.role === 'supervisor') {
        const drift = describePublicUrlDrift(ctx.state.publicUrl, domain);
        if (drift) ctx.ui.error(drift);
        if (opts.publicUrlConfigFile) {
          const hookContent = renewalGuardHookScript(domain, opts.publicUrlConfigFile);
          await sudoStep(ctx, {
            description: "Install a renewal deploy-hook that warns (never blocks) if CEZ_PUBLIC_URL drifts from the renewed domain.",
            note: `This writes ${RENEWAL_GUARD_HOOK_PATH} with exactly this content:\n\n${hookContent}`,
            command: writeRootFileCommand(RENEWAL_GUARD_HOOK_PATH, hookContent, `chmod 0755 ${shquote(RENEWAL_GUARD_HOOK_PATH)}`),
            verify: (c) => verifyCommand(c, 'test', ['-f', RENEWAL_GUARD_HOOK_PATH]),
          });
          artifacts.push(owned('file', { path: RENEWAL_GUARD_HOOK_PATH }));
        }
      }
      // Display-only for both roles, exactly like ubuntu-vps.ts's sslStep sets ctx.state.publicUrl
      // unconditionally — set AFTER the drift check above, which needs the PREVIOUS value.
      ctx.state.publicUrl = publicUrlForDomain(domain);

      return { artifacts };
    },
    async undo(ctx, created) {
      const cert = (created?.artifacts ?? []).find((a) => a.type === 'cert');
      if (cert) {
        ctx.ui.note(
          `The TLS certificate for ${cert.name ?? domain} and its auto-renewal timer were left in place.\nRemove it yourself if you want it gone:\n${cert.removeHint ?? ''}`,
          'TLS',
        );
      }
      const pkgs = (created?.artifacts ?? []).filter((a) => a.type === 'package');
      if (pkgs.length > 0) {
        ctx.ui.note(
          pkgs.map((a) => a.removeHint ?? a.name ?? '').filter(Boolean).join('\n'),
          'Installed for cezar but possibly used elsewhere — remove manually if unwanted',
        );
      }
      const hook = (created?.artifacts ?? []).find((a) => a.type === 'file' && a.path === RENEWAL_GUARD_HOOK_PATH);
      if (hook?.path) {
        await sudoStep(ctx, {
          description: 'Remove the CEZ_PUBLIC_URL renewal guard hook.',
          command: `rm -f ${shquote(hook.path)}`,
          verify: (c) => verifyCommand(c, 'sh', ['-c', `! test -f ${shquote(hook.path as string)}`]),
        });
      }
    },
  };
}
