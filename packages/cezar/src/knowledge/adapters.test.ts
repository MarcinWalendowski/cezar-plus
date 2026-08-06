import { describe, expect, it } from 'vitest';
import { FORMAT_ADAPTERS, resolveKnowledgeFormat, runFormatAdapter } from './adapters.ts';

describe('resolveKnowledgeFormat', () => {
  it('recognises the four known formats and degrades everything else to markdown', () => {
    expect(resolveKnowledgeFormat('markdown')).toBe('markdown');
    expect(resolveKnowledgeFormat('bullet-meta')).toBe('bullet-meta');
    expect(resolveKnowledgeFormat('line-meta')).toBe('line-meta');
    expect(resolveKnowledgeFormat('strict-frontmatter')).toBe('strict-frontmatter');
    expect(resolveKnowledgeFormat('acme-spec')).toBe('markdown');
    expect(resolveKnowledgeFormat('totally-bogus')).toBe('markdown');
    expect(resolveKnowledgeFormat(undefined)).toBe('markdown');
  });
});

describe('markdown adapter', () => {
  const adapter = FORMAT_ADAPTERS.markdown;

  it('treats a bare document with no frontmatter as fully valid, with no warning', () => {
    const raw = '# A bare note\n\nJust prose, no frontmatter at all.\n';
    const result = adapter(raw, '/repo/a-bare-note.md');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(raw);
    expect(result.warnings).toEqual([]);
  });

  it('parses a well-formed frontmatter block and strips it from the body', () => {
    const raw = '---\ntitle: Hello\ntags: [a, b]\n---\nBody text.\n';
    const result = adapter(raw, '/repo/x.md');
    expect(result.frontmatter).toEqual({ title: 'Hello', tags: ['a', 'b'] });
    expect(result.body).toBe('Body text.\n');
    expect(result.warnings).toEqual([]);
  });

  it('treats empty frontmatter as a legitimate empty object, no warning', () => {
    const raw = '---\n---\nBody text.\n';
    const result = adapter(raw, '/repo/x.md');
    expect(result.frontmatter).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('degrades malformed YAML to an empty object plus a warning, never throws', () => {
    const raw = '---\nfoo: [unterminated\n---\nBody text.\n';
    const result = adapter(raw, '/repo/x.md');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('Body text.\n');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('markdown:');
  });

  it('degrades a non-mapping frontmatter block (a YAML list) to an empty object plus a warning', () => {
    const raw = '---\n- one\n- two\n---\nBody text.\n';
    const result = adapter(raw, '/repo/x.md');
    expect(result.frontmatter).toEqual({});
    expect(result.warnings[0]).toContain('did not parse to a mapping');
  });

  it('never mistakes a horizontal rule later in the document for a second fence', () => {
    const raw = '---\ntitle: X\n---\nIntro.\n\n---\n\nMore text after a horizontal rule.\n';
    const result = adapter(raw, '/repo/x.md');
    expect(result.frontmatter).toEqual({ title: 'X' });
    expect(result.body).toBe('Intro.\n\n---\n\nMore text after a horizontal rule.\n');
  });
});

describe('strict-frontmatter adapter', () => {
  const adapter = FORMAT_ADAPTERS['strict-frontmatter'];

  it('reports a missing frontmatter block, unlike markdown, but still indexes the document', () => {
    const raw = '# A note with no frontmatter\n\nBody.\n';
    const result = adapter(raw, '/repo/x.md');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(raw);
    expect(result.warnings).toEqual(['strict-frontmatter: no YAML frontmatter block found']);
  });

  it('reports malformed YAML with a prefixed warning', () => {
    const raw = '---\nfoo: [unterminated\n---\nBody.\n';
    const result = adapter(raw, '/repo/x.md');
    expect(result.frontmatter).toEqual({});
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('strict-frontmatter:');
    expect(result.warnings[0]).toContain('did not parse as YAML');
  });

  it('parses a well-formed frontmatter block with no warning', () => {
    const raw = '---\nname: my-note\nmetadata:\n  type: reference\n---\nBody.\n';
    const result = adapter(raw, '/repo/x.md');
    expect(result.frontmatter).toEqual({ name: 'my-note', metadata: { type: 'reference' } });
    expect(result.warnings).toEqual([]);
  });
});

describe('bullet-meta adapter', () => {
  const adapter = FORMAT_ADAPTERS['bullet-meta'];

  it('extracts the H1 as title and a leading block of bold-key bullets, keeping body untouched', () => {
    const raw = [
      '# SPEC-053 — Acme "Aurora" Visual Redesign',
      '',
      '- **Date:** 2026-06-10',
      '- **Status:** Implemented',
      '- **Surfaces:** `domains/platform/marketing`',
      '',
      '## TLDR',
      '',
      'Rebrand all Acme UI surfaces.',
      '',
    ].join('\n');
    const result = adapter(raw, '/repo/spec-053.md');
    expect(result.frontmatter).toEqual({
      title: 'SPEC-053 — Acme "Aurora" Visual Redesign',
      date: '2026-06-10',
      status: 'Implemented',
      surfaces: '`domains/platform/marketing`',
    });
    // The leading block is ordinary rendered prose, not hidden metadata — body is the whole file.
    expect(result.body).toBe(raw);
    expect(result.warnings).toEqual([]);
  });

  it('stops at the first blank line and never reaches back into later prose bullets', () => {
    const raw = '# Title\n\nSome intro prose.\n\n- **Status:** should not be captured\n';
    const result = adapter(raw, '/repo/x.md');
    expect(result.frontmatter).toEqual({ title: 'Title' });
  });

  it('degrades a document with no H1 and no bullets to an empty frontmatter, body untouched', () => {
    const raw = 'Just a paragraph, no heading, no bullets.\n';
    const result = adapter(raw, '/repo/x.md');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(raw);
  });
});

describe('line-meta adapter', () => {
  const adapter = FORMAT_ADAPTERS['line-meta'];

  it('extracts the H1 as title and leading plain Key: value lines, keeping body untouched', () => {
    const raw = [
      '# 000 — Plan implementacji Cez',
      '',
      'Status: aktywny · Aktualizowany przy każdej zmianie zakresu',
      '',
      '## Zasady nadrzędne',
      '',
    ].join('\n');
    const result = adapter(raw, '/repo/000-plan.md');
    expect(result.frontmatter).toEqual({
      title: '000 — Plan implementacji Cez',
      status: 'aktywny · Aktualizowany przy każdej zmianie zakresu',
    });
    expect(result.body).toBe(raw);
    expect(result.warnings).toEqual([]);
  });

  it('does not treat a prose sentence containing a colon as a key: value line', () => {
    const raw = '# Title\n\nSee the note below: it explains everything.\n\n## Next\n';
    const result = adapter(raw, '/repo/x.md');
    // "See the note below" is not `[A-Za-z][A-Za-z0-9_-]{0,40}` (it contains spaces), so it is
    // never captured as a metadata line.
    expect(result.frontmatter).toEqual({ title: 'Title' });
  });
});

describe('runFormatAdapter', () => {
  it('dispatches through the registry and falls back to markdown for an unknown format', () => {
    const raw = '# Title\n\nBody.\n';
    const known = runFormatAdapter(raw, '/repo/x.md', 'markdown');
    const unknown = runFormatAdapter(raw, '/repo/x.md', 'not-a-real-format');
    expect(unknown).toEqual(known);
  });
});
