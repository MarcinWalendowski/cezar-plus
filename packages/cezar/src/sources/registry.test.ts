import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveSourceProvider, SOURCE_PROVIDERS } from './registry.ts';
import { sourceCapabilitiesSchema } from './provider-types.ts';
import { NOTION_SOURCE_KIND } from './notion/provider.ts';

/**
 * `registry.ts` - the seam's dispatch table (F2, W2.2). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` phase "2.2" for the exact test list
 * this file implements, folded together with phase "2.1"'s capabilities-parse control (there is no
 * separate `provider-types.test.ts` in this package's file ownership).
 */

describe('resolveSourceProvider', () => {
  it('returns null for an unknown kind, and does not throw', () => {
    expect(() => resolveSourceProvider({ kind: 'nope' })).not.toThrow();
    expect(resolveSourceProvider({ kind: 'nope' })).toBeNull();
  });

  it('resolves the notion provider for a connection declaring kind: "notion"', () => {
    const provider = resolveSourceProvider({
      kind: NOTION_SOURCE_KIND,
      id: 'conn-1',
      revision: 1,
      name: 'Acme workspace',
      collections: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(provider).not.toBeNull();
    expect(provider?.kind).toBe('notion');
  });

  it('SOURCE_PROVIDERS is keyed by kind string, not a literal union', () => {
    expect(Object.keys(SOURCE_PROVIDERS)).toEqual(['notion']);
  });
});

describe('no git-remote resolution on this path', () => {
  // Built by concatenation, on purpose: writing either forbidden term as one contiguous literal
  // in THIS file would make it its own offender under the spec's own grep-based check over the
  // whole `sources/` directory, this test file included.
  const forbidden = [['git', 'hub.com'].join(''), ['parse', 'Remote'].join('')];

  it('no source file references a git host or its parsing helper by name', () => {
    const sourcesDir = fileURLToPath(new URL('.', import.meta.url));
    const offenders: string[] = [];
    for (const path of listTsFiles(sourcesDir)) {
      const text = readFileSync(path, 'utf8');
      if (forbidden.some((term) => text.includes(term))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});

describe('SourceCapabilities (spec phase 2.1)', () => {
  it('parses a fully-populated capabilities object', () => {
    expect(() =>
      sourceCapabilitiesSchema.parse({ list: true, fetch: true, poll: true, push: false, comments: true }),
    ).not.toThrow();
  });

  it('a capabilities object missing one boolean fails parse', () => {
    const { poll: _poll, ...missingPoll } = { list: true, fetch: true, poll: true, push: false, comments: true };
    expect(() => sourceCapabilitiesSchema.parse(missingPoll)).toThrow();
  });
});

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'fixtures') continue;
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...listTsFiles(`${path}/`));
    } else if (entry.name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}
