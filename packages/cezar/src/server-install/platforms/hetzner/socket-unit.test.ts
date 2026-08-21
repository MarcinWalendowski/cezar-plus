import { describe, expect, it } from 'vitest';

import { cezarRunsSlice, cezarSocketUnit, nonDisruptiveDropIn } from './socket-unit.ts';
import { resolveSocketActivation } from '../../../server/socket-activation.ts';

/**
 * P3/P4 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`.
 *
 * Unit text is asserted verbatim where the directive is load-bearing, following the pairing
 * discipline `systemd-unit.test.ts` already applies: a generated unit is checked against the real
 * consumer of its values, not just against itself.
 */

const socket = cezarSocketUnit({ bindHost: '127.0.0.1', port: 4321, serviceUnit: 'cezar.service' });

describe('cezarSocketUnit', () => {
  it('listens on the fixed loopback contract the tunnel ingress names', () => {
    expect(socket).toContain('ListenStream=127.0.0.1:4321');
  });

  it('is Accept=no — one long-lived server inherits the socket, not one instance per connection', () => {
    expect(socket).toContain('Accept=no');
    expect(socket).not.toContain('Accept=yes');
  });

  it('keeps queued connections across a restart', () => {
    expect(socket).toContain('FlushPending=no');
  });

  it('has a backlog deep enough to absorb a restart, and it is tunable', () => {
    expect(socket).toContain('Backlog=1024');
    expect(cezarSocketUnit({ bindHost: '127.0.0.1', port: 1, serviceUnit: 'x.service', backlog: 42 })).toContain(
      'Backlog=42',
    );
  });

  it('is enabled via sockets.target and ordered before the service', () => {
    expect(socket).toContain('WantedBy=sockets.target');
    expect(socket).toContain('Before=cezar.service');
  });
});

describe('nonDisruptiveDropIn', () => {
  const dropIn = nonDisruptiveDropIn({ socketUnit: 'cezar.socket' });

  it('binds the inherited socket to the service', () => {
    expect(dropIn).toContain('Sockets=cezar.socket');
  });

  it('sets KillMode=process — the directive that stops a deploy SIGKILLing every agent run', () => {
    expect(dropIn).toContain('KillMode=process');
    expect(dropIn).not.toContain('KillMode=control-group');
  });

  it('delegates cgroups so the cockpit can isolate run brokers itself', () => {
    expect(dropIn).toContain('Delegate=yes');
  });

  it('allows a stop timeout longer than the drain window', () => {
    // CEZ_DRAIN_MS defaults to 5s; a TimeoutStopSec at or under that would have systemd
    // SIGKILL the process part-way through the graceful drain P3 just built.
    const match = /TimeoutStopSec=(\d+)/.exec(dropIn);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThan(5);
  });

  it('touches only [Service] — it must not restate anything the hand-written unit owns', () => {
    expect(dropIn).toContain('[Service]');
    expect(dropIn).not.toContain('[Unit]');
    expect(dropIn).not.toContain('[Install]');
    expect(dropIn).not.toContain('ExecStart=');
    expect(dropIn).not.toContain('EnvironmentFile=');
    expect(dropIn).not.toContain('User=');
  });
});

describe('cezarRunsSlice', () => {
  it('is a slice unit', () => {
    expect(cezarRunsSlice()).toContain('[Slice]');
  });
});

describe('unit text pairs with the code that consumes it', () => {
  it('the socket unit activates a server that accepts the systemd handshake', () => {
    // The unit is Accept=no with one ListenStream, so systemd passes exactly one fd. Feed that
    // shape to the REAL resolver rather than asserting the unit against itself.
    const result = resolveSocketActivation({ LISTEN_PID: '4242', LISTEN_FDS: '1', LISTEN_FDNAMES: 'cezar.socket' }, 4242);
    expect(result.activated).toBe(true);
    expect(result.activated && result.socket.fd).toBe(3);
    expect(socket.match(/ListenStream=/g)).toHaveLength(1);
  });
});
