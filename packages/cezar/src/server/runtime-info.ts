import { basename, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BROKERED_BACKENDS, brokerAvailable } from '../core/broker-launch.ts';
import type { BrokerIsolation } from '../core/broker-isolation.ts';
import { loadLedger } from '../server-install/releases.ts';

/**
 * What `/api/v1/health` and `/api/v1/ready` report about how this process was started
 * (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * The spec asks for these fields for one reason, stated in its own Risks section: the degraded
 * mode is invisible otherwise. A cezar with `runBrokerIsolation: 'none'` behaves identically to a
 * fully non-disruptive one right up until the deploy that kills every in-flight run. "It worked on
 * the box we tested" is exactly the claim these fields exist to stop anyone making.
 */

export interface RuntimeInfo {
  socketActivated: boolean;
  runBrokerIsolation: BrokerIsolation;
  brokeredBackends: string[];
  brokerAvailable: boolean;
}

export interface DeployInfo {
  releaseId?: string;
  version?: string;
  sha?: string;
  activatedAt?: string;
  builtAt?: string;
  dirty?: boolean;
}

export function runtimeInfo(opts: {
  socketActivated: boolean;
  isolation: BrokerIsolation;
  env?: NodeJS.ProcessEnv;
}): RuntimeInfo {
  const available = brokerAvailable(opts.env ?? process.env);
  return {
    socketActivated: opts.socketActivated,
    runBrokerIsolation: opts.isolation,
    // Empty when brokering is off, rather than listing `claude` and being wrong: this field is
    // read as "these runs survive a deploy", and a list that is true only in principle is worse
    // than an empty one.
    brokeredBackends: available ? [...BROKERED_BACKENDS] : [],
    brokerAvailable: available,
  };
}

/**
 * The release this process is serving, read from the ledger rather than from a marker file.
 *
 * Derived from where THIS MODULE actually lives, which is the only honest source: a
 * `.deployed-commit` file (what the box has today) says what someone wrote into it, and drifts the
 * moment a deploy half-fails. If the install root's parent holds a `deploy.json` naming a release
 * whose id is the install root's basename, that is the release we are running — the layout P1
 * creates, and one nothing else produces by accident.
 *
 * Returns `undefined` for every non-release install (`npx cezar`, a dev checkout, the old rsync
 * layout), which is correct rather than degraded: those genuinely have no release identity.
 */
export function currentRelease(moduleUrl = import.meta.url): DeployInfo | undefined {
  // <install>/packages/cezar/dist/server/runtime-info.js → up four is the install root.
  const here = dirname(fileURLToPath(moduleUrl));
  const installRoot = resolvePath(here, '..', '..', '..', '..');
  const releasesDir = dirname(installRoot);
  const id = basename(installRoot);
  try {
    const ledger = loadLedger(releasesDir);
    const entry = ledger.releases.find((r) => r.id === id);
    if (!entry) return undefined;
    return {
      releaseId: entry.id,
      version: entry.version,
      sha: entry.sha,
      activatedAt: entry.activatedAt,
      builtAt: entry.builtAt,
      dirty: entry.dirty,
    };
  } catch {
    // No ledger, an unreadable one, or a directory that is not a release: all mean the same thing.
    return undefined;
  }
}
