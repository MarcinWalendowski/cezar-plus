import { describe, expect, it } from 'vitest';

import { contextWindowForModel } from './context-window.ts';

describe('contextWindowForModel', () => {
  it('maps standard Claude models to 200k', () => {
    expect(contextWindowForModel('opus')).toBe(200_000);
    expect(contextWindowForModel('claude-opus-4-8')).toBe(200_000);
    expect(contextWindowForModel('sonnet')).toBe(200_000);
    expect(contextWindowForModel('haiku')).toBe(200_000);
  });

  it('maps the [1m] beta to 1M, over the standard Claude match', () => {
    expect(contextWindowForModel('sonnet[1m]')).toBe(1_000_000);
    expect(contextWindowForModel('claude-sonnet-4-5[1m]')).toBe(1_000_000);
  });

  it('prefers the resolved identity over a free-text auto model', () => {
    expect(contextWindowForModel('auto', 'anthropic/claude-opus-4-8')).toBe(200_000);
  });

  it('is undefined for an unmodelled runner rather than guessing', () => {
    expect(contextWindowForModel('gpt-5')).toBeUndefined();
    expect(contextWindowForModel('o3')).toBeUndefined();
    expect(contextWindowForModel(undefined)).toBeUndefined();
    expect(contextWindowForModel('')).toBeUndefined();
    // `auto` with no known identity yet stays unknown — never a default.
    expect(contextWindowForModel('auto')).toBeUndefined();
  });
});
