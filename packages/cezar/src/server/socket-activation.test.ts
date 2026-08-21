import { describe, expect, it } from 'vitest';

import {
  SD_LISTEN_FDS_START,
  consumeSocketActivation,
  describeListenTarget,
  resolveSocketActivation,
} from './socket-activation.ts';

/** P3 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`. */

describe('resolveSocketActivation', () => {
  it('accepts a well-formed handshake addressed to this pid', () => {
    const r = resolveSocketActivation({ LISTEN_PID: '4242', LISTEN_FDS: '1' }, 4242);
    expect(r).toEqual({ activated: true, socket: { fd: SD_LISTEN_FDS_START, count: 1, name: undefined } });
  });

  it('carries the fd name when systemd supplies one, taking the first of several', () => {
    const r = resolveSocketActivation(
      { LISTEN_PID: '7', LISTEN_FDS: '2', LISTEN_FDNAMES: 'cezar.socket:other.socket' },
      7,
    );
    expect(r.activated && r.socket.name).toBe('cezar.socket');
    expect(r.activated && r.socket.count).toBe(2);
  });

  it('is inert when nothing is set — the ordinary local `cezar serve`', () => {
    const r = resolveSocketActivation({}, 1);
    expect(r.activated).toBe(false);
    expect(r.activated === false && r.reason).toMatch(/not socket-activated/);
  });

  it('REFUSES when LISTEN_PID belongs to another process', () => {
    // The case that matters: cezar spawns agent CLIs constantly. A child inheriting these
    // variables must not conclude it owns a listening socket on fd 3 — fd 3 in a child is
    // whatever that child opened.
    const r = resolveSocketActivation({ LISTEN_PID: '4242', LISTEN_FDS: '1' }, 9999);
    expect(r.activated).toBe(false);
    expect(r.activated === false && r.reason).toMatch(/not this process/);
  });

  it('refuses a missing or nonsense LISTEN_FDS', () => {
    expect(resolveSocketActivation({ LISTEN_PID: '5' }, 5).activated).toBe(false);
    expect(resolveSocketActivation({ LISTEN_PID: '5', LISTEN_FDS: '0' }, 5).activated).toBe(false);
    expect(resolveSocketActivation({ LISTEN_PID: '5', LISTEN_FDS: 'many' }, 5).activated).toBe(false);
    expect(resolveSocketActivation({ LISTEN_PID: '5', LISTEN_FDS: '-1' }, 5).activated).toBe(false);
  });
});

describe('consumeSocketActivation', () => {
  it('scrubs the variables so spawned agent CLIs never see them', () => {
    const env: NodeJS.ProcessEnv = { LISTEN_PID: '4242', LISTEN_FDS: '1', LISTEN_FDNAMES: 'cezar.socket', OTHER: 'keep' };
    const r = consumeSocketActivation(env, 4242);
    expect(r.activated).toBe(true);
    expect(env.LISTEN_PID).toBeUndefined();
    expect(env.LISTEN_FDS).toBeUndefined();
    expect(env.LISTEN_FDNAMES).toBeUndefined();
    expect(env.OTHER).toBe('keep');
  });

  it('scrubs even when the handshake is refused, so a mismatched child cannot pass them on', () => {
    const env: NodeJS.ProcessEnv = { LISTEN_PID: '1', LISTEN_FDS: '1' };
    expect(consumeSocketActivation(env, 2).activated).toBe(false);
    expect(env.LISTEN_PID).toBeUndefined();
    expect(env.LISTEN_FDS).toBeUndefined();
  });
});

describe('describeListenTarget', () => {
  it('names the fd when activated and the port otherwise', () => {
    expect(describeListenTarget(resolveSocketActivation({ LISTEN_PID: '3', LISTEN_FDS: '1' }, 3), 4321)).toMatch(
      /inherited fd 3/,
    );
    expect(describeListenTarget(resolveSocketActivation({}, 3), 4321)).toBe('port 4321');
  });
});
