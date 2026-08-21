import { connect, type Socket } from 'node:net';

import type { BrokerResponse } from './run-broker.ts';
import { spoolPaths } from './run-spool.ts';

/**
 * Control-socket client for a run broker (P4 of
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * This is the half of `AgentSession` that cannot be served by tailing a file: `sendMessage`,
 * `end` and `interrupt` all have to reach the live backend's stdin, which only the broker holds.
 *
 * Connections are made per request rather than held open, and that is deliberate. A long-lived
 * control socket would have to survive the server being replaced — reconnect logic, half-open
 * detection, a queue of writes issued while disconnected — for no benefit: control traffic is a
 * handful of messages per turn, and a per-request connect makes "is the broker still there?" and
 * "did my message land?" the same question with the same answer.
 */

export const CONTROL_TIMEOUT_MS = 5_000;

export class BrokerUnavailableError extends Error {
  constructor(spoolDir: string, cause: string) {
    super(`run broker for ${spoolDir} is unreachable: ${cause}`);
    this.name = 'BrokerUnavailableError';
  }
}

/** Send one control request and await its single-line reply. */
export function brokerRequest(
  spoolDir: string,
  request: Record<string, unknown>,
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<BrokerResponse> {
  const path = spoolPaths(spoolDir).ctl;
  return new Promise<BrokerResponse>((resolve, reject) => {
    let socket: Socket;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // already gone
      }
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new BrokerUnavailableError(spoolDir, `no reply within ${timeoutMs}ms`))),
      timeoutMs,
    );

    try {
      socket = connect(path);
    } catch (err) {
      finish(() => reject(new BrokerUnavailableError(spoolDir, (err as Error).message)));
      return;
    }

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      finish(() => {
        try {
          resolve(JSON.parse(line) as BrokerResponse);
        } catch {
          reject(new BrokerUnavailableError(spoolDir, 'malformed reply'));
        }
      });
    });
    socket.on('error', (err) => finish(() => reject(new BrokerUnavailableError(spoolDir, err.message))));
    socket.on('close', () =>
      finish(() => reject(new BrokerUnavailableError(spoolDir, 'closed before replying'))),
    );
  });
}

/** Is a broker answering on this spool's control socket? Used by the boot re-attach sweep as the
 *  liveness check that a pid test alone cannot give — a pid can be alive but wedged. */
export async function brokerResponds(spoolDir: string, timeoutMs = CONTROL_TIMEOUT_MS): Promise<boolean> {
  try {
    const reply = await brokerRequest(spoolDir, { op: 'status' }, timeoutMs);
    return reply.ok === true;
  } catch {
    return false;
  }
}
