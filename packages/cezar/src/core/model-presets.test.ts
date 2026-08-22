import { describe, expect, it } from 'vitest';
import { KNOWN_PRESETS_BY_RUNNER, modelConflictsWithRunner } from './model-presets.ts';

describe('modelConflictsWithRunner', () => {
  it('never rejects auto or a runner\'s own preset', () => {
    expect(modelConflictsWithRunner('', 'opencode')).toBe(false);
    expect(modelConflictsWithRunner('opus', 'claude')).toBe(false);
    expect(modelConflictsWithRunner('gpt-5.6-terra', 'codex')).toBe(false);
  });

  it('rejects another runner\'s preset', () => {
    expect(modelConflictsWithRunner('opus', 'codex')).toBe(true);
    expect(modelConflictsWithRunner('gpt-5.6-terra', 'claude')).toBe(true);
    expect(modelConflictsWithRunner('claude-opus-4-8', 'codex')).toBe(true);
    // …but an unlisted gateway id stays usable on claude, which supports them by design.
    expect(modelConflictsWithRunner('openai/gpt-5.4', 'claude')).toBe(false);
  });

  /**
   * Guards the 2026-08-22 correction. All three ids this list used to carry were probed against
   * the authenticated codex on prod-host and every one was rejected
   * (`Model metadata not found` → 400). A picker whose every option fails is worse than no
   * picker, so their absence is asserted rather than left to a comment.
   */
  it('ships no codex id that production measured dead', () => {
    for (const dead of ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5-codex']) {
      expect(KNOWN_PRESETS_BY_RUNNER.codex).not.toContain(dead);
    }
    // Owner instruction 2026-08-22, "in codex use only 5.6": the 5.6 family, and nothing older.
    // Asserted as the WHOLE list rather than three `toContain`s, because the instruction is about
    // what is absent as much as what is present, and `toContain` cannot see an extra entry.
    expect([...KNOWN_PRESETS_BY_RUNNER.codex]).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    for (const id of KNOWN_PRESETS_BY_RUNNER.codex) expect(id.startsWith('gpt-5.6-')).toBe(true);
  });

  it('rejects a provider the runner cannot serve, without naming any model', () => {
    expect(modelConflictsWithRunner('anthropic/claude-opus-4-8', 'codex')).toBe(true);
    // A model that did not exist when this code was written is guarded just the same.
    expect(modelConflictsWithRunner('anthropic/claude-opus-9', 'codex')).toBe(true);
    expect(modelConflictsWithRunner('openai/gpt-5.4', 'codex')).toBe(false);
  });

  it('leaves an unfamiliar prefix alone — it may be the runner\'s configured gateway', () => {
    // The run-time gate reads the runner's configured provider and can accept this; this
    // synchronous guard cannot, so it must not pre-empt that decision.
    expect(modelConflictsWithRunner('my-org/custom-tune', 'codex')).toBe(false);
  });

  it('never rejects a provider prefix for OpenCode, which serves every provider', () => {
    expect(modelConflictsWithRunner('anthropic/claude-sonnet-5', 'opencode')).toBe(false);
    expect(modelConflictsWithRunner('openai/gpt-5.4', 'opencode')).toBe(false);
    // …while another runner's bare preset is still recognizably not an OpenCode id.
    expect(modelConflictsWithRunner('opus', 'opencode')).toBe(true);
  });

  it('accepts every provider-qualified OpenCode id, including ones no release knows (#794)', () => {
    for (const model of ['openai/gpt-5.5-fast', 'anthropic/claude-sonnet-5', 'zed/some-future-model']) {
      expect(modelConflictsWithRunner(model, 'opencode')).toBe(false);
    }
  });

  it('keeps no hard-coded OpenCode catalog to drift', () => {
    expect(KNOWN_PRESETS_BY_RUNNER.opencode).toEqual([]);
  });
});
