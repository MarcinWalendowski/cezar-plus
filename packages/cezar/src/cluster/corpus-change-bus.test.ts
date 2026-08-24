import { afterEach, describe, expect, it } from 'vitest';
import { emitCorpusChanged, resetCorpusChangeListenerForTests, setCorpusChangeListener } from './corpus-change-bus.ts';

afterEach(() => resetCorpusChangeListenerForTests());

describe('corpus change bus', () => {
  it('delivers an emit to the registered listener', () => {
    let calls = 0;
    setCorpusChangeListener(() => void calls++);
    emitCorpusChanged();
    expect(calls).toBe(1);
  });

  it('emitting with NOTHING registered is a silent no-op, not a throw', () => {
    // The ordinary state on a spoke, on a non-clustered cockpit, and on a hub before its runtime
    // has armed. A throw here would fail the reindex that provoked it.
    expect(() => emitCorpusChanged()).not.toThrow();
  });

  it('a listener that throws does not propagate, and is warned', () => {
    const warnings: string[] = [];
    setCorpusChangeListener(
      () => {
        throw new Error('broadcast exploded');
      },
      { warn: (m) => void warnings.push(m) },
    );
    expect(() => emitCorpusChanged()).not.toThrow();
    expect(warnings.some((m) => m.includes('corpus-change listener threw'))).toBe(true);
  });

  it('registering replaces rather than accumulates', () => {
    let a = 0;
    let b = 0;
    setCorpusChangeListener(() => void a++);
    setCorpusChangeListener(() => void b++);
    emitCorpusChanged();
    // The negative half is `a`: an implementation that appended to a list would leave a === 1, and
    // a hub restarting ~10x/day would end the day broadcasting ten times per change.
    expect(b).toBe(1);
    expect(a).toBe(0);
  });

  it('a superseded runtime disposing does NOT unregister its successor', () => {
    // The blue-green case: runtime 1 arms, runtime 2 replaces it, runtime 1's teardown then runs
    // late. Without the identity check in the disposer this clears runtime 2's listener and the
    // corpus silently stops broadcasting — indistinguishable from a corpus that never changes.
    let live = 0;
    const disposeOld = setCorpusChangeListener(() => {
      throw new Error('the old runtime should never be called again');
    });
    setCorpusChangeListener(() => void live++);
    disposeOld();
    emitCorpusChanged();
    expect(live).toBe(1);
  });

  it('disposing the CURRENT listener does clear it', () => {
    let calls = 0;
    const dispose = setCorpusChangeListener(() => void calls++);
    dispose();
    emitCorpusChanged();
    expect(calls).toBe(0);
  });
});
