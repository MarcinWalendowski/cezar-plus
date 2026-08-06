import { describe, expect, it } from 'vitest';
import { parseDocument } from './parse.ts';

// ---- real-corpus fixtures --------------------------------------------------------------------
//
// Verbatim excerpts (not paraphrased) from files that already exist in this workspace, so the
// adapters are proven against the actual shapes they have to survive, not an invented ideal case.

/** Verbatim from `chat/.ai/specs/SPEC-001-2026-03-13-architecture-overview.md` — a real chat spec
 *  with NO frontmatter at all. */
const SPEC_001_EXCERPT =
  '# SPEC-001: Architecture Overview\n\n' +
  '## TLDR\n\n' +
  'Defines the monorepo structure, service boundaries, and data flow for the messaging platform. ' +
  'An agent on each Mac pushes events through a Cloudflare Worker (`edge-api`) which stores them ' +
  'in D1 and delivers webhooks. Send commands flow back to the agent via Cloudflare Tunnel. The ' +
  'Worker exposes API compatible endpoints. edge-dash (React 19 + Vite 6 on Cloudflare Worker with ' +
  'static assets) reads all data from D1. All services deploy on Cloudflare (Workers, D1, Tunnel).\n';

/** Verbatim from `chat/.ai/specs/SPEC-071-2026-07-02-actor-onboarding-codes.md` — a real chat
 *  spec whose Status bullet is a COMPOUND string naming both "Superseded" and "Implemented".
 *  This is the exact case the spec's status-precedence rule exists for. */
const SPEC_071_EXCERPT = [
  '# SPEC-071 — Actor Onboarding: First-Message Codes, Discovery Flow, Per-Distribution Attribution',
  '',
  '- **Status:** Superseded by SPEC-282 (2026-07-25) — was Implemented (code complete; manual ' +
    'setup + device E2E pending, see Manual Setup). Actors are retired: `agent_actors`, ' +
    '`manage_actors`, `get_actor_link`, the `actor-discovery` prompt section and `agent/actors.ts` ' +
    'are all gone, and every consumer product is now its own agent row rather than a persona the core agent ' +
    'plays.',
  '- **Date:** 2026-07-02',
  '- **Domains:** platform (templates, codes, redemption, attribution) + chatbots (binding, prompt, tools) + beside/web (landing page)',
  '- **Extends:** SPEC-067 (referrals ride onboarding codes), SPEC-051 (multi-actor model)',
  '',
  '## TLDR',
  '',
  'The core agent plays multiple **actors** — personas defined purely by config + branding',
].join('\n');

/** Verbatim from cezar's own `.ai/specs/000-plan.md` — the `line-meta` shape cezar's own specs
 *  and run plans use. */
const PLAN_000_EXCERPT = [
  '# 000 — Plan implementacji Cez',
  '',
  'Status: aktywny · Aktualizowany przy każdej zmianie zakresu',
  '',
  '## Zasady nadrzędne (obowiązują każdą specyfikację)',
  '',
  '**UX jak konstrukcja cepa.** Prostota jest ważniejsza niż każda funkcja z osobna.',
].join('\n');

/** Verbatim (non-contiguous excerpt) from a real Claude memory note under
 *  `~/.claude/projects/<workspace>/memory/a-lease-shorter-than-the-job-duplicates-the-work.md`
 *  — the strict frontmatter shape (`name`, `description`, `metadata.type`) plus real `[[wikilinks]]`
 *  in the body. */
const MEMORY_NOTE_EXCERPT =
  '---\n' +
  'name: a-lease-shorter-than-the-job-duplicates-the-work\n' +
  'description: "Cloudflare PUSH consumers have no visibility_timeout_ms — wrangler accepts it ' +
  'and silently drops it, so a config knob this repo credited for a production fix had never ' +
  'applied; the duplication it blamed is real but the lever is max_batch_size (invocation length)"\n' +
  'metadata:\n' +
  '  type: project\n' +
  '  originSessionId: 6637b97a-09d8-4e0d-8467-6d94f203c591\n' +
  '  modified: 2026-08-04T04:16:59.350Z\n' +
  '---\n\n' +
  '**Before buying capacity for a saturated resource, check whether the load is\n' +
  'necessary.** The cheapest cause of "the database is overloaded" is the same work\n' +
  'running several times at once.\n\n' +
  'Related: [[d1-writes-cost-1000x-reads]], [[a-report-names-a-symptom-not-a-cause]],\n' +
  '[[keep-last-good-needs-a-staleness-alarm]],\n' +
  '[[zero-errors-is-not-health-until-the-channel-is-proven]],\n' +
  '[[cloudflare-observability-is-the-error-channel]].\n';

describe('parseDocument: a real spec with no frontmatter', () => {
  it('falls back title to the first H1 and defaults everything else, body untouched', () => {
    const doc = parseDocument(
      SPEC_001_EXCERPT,
      '/repo/chat/.ai/specs/SPEC-001-2026-03-13-architecture-overview.md',
      'markdown',
    );
    expect(doc.title).toBe('SPEC-001: Architecture Overview');
    expect(doc.type).toBe('note');
    expect(doc.status).toBe('current');
    expect(doc.statusRaw).toBeUndefined();
    expect(doc.tags).toEqual([]);
    expect(doc.identifiers).toEqual([]);
    expect(doc.body).toBe(SPEC_001_EXCERPT);
    expect(doc.warnings).toEqual([]);
  });
});

describe('parseDocument: a compound status string', () => {
  it('reads "Superseded by X (was Implemented)" as superseded, not current — precedence is load-bearing', () => {
    const doc = parseDocument(
      SPEC_071_EXCERPT,
      '/repo/chat/.ai/specs/SPEC-071-2026-07-02-actor-onboarding-codes.md',
      'bullet-meta',
    );
    expect(doc.title).toBe(
      'SPEC-071 — Actor Onboarding: First-Message Codes, Discovery Flow, Per-Distribution Attribution',
    );
    expect(doc.status).toBe('superseded');
    expect(doc.statusRaw).toContain('Superseded by SPEC-282');
    expect(doc.statusRaw).toContain('was Implemented');
    // The leading bullet block is rendered prose, not hidden metadata — body is the whole file.
    expect(doc.body).toBe(SPEC_071_EXCERPT);
  });

  it('reproduces the same precedence directly, isolated from any real-file noise', () => {
    const raw = '---\nstatus: "Superseded by X (was Implemented)"\n---\nBody.\n';
    const doc = parseDocument(raw, '/repo/x.md', 'markdown');
    expect(doc.status).toBe('superseded');
    expect(doc.statusRaw).toBe('Superseded by X (was Implemented)');
  });
});

describe('parseDocument: a line-meta spec', () => {
  it('extracts the H1 title and a plain Key: value status line, in the shape cezar\'s own specs use', () => {
    const doc = parseDocument(PLAN_000_EXCERPT, '/repo/cezar/.ai/specs/000-plan.md', 'line-meta');
    expect(doc.title).toBe('000 — Plan implementacji Cez');
    expect(doc.statusRaw).toBe('aktywny · Aktualizowany przy każdej zmianie zakresu');
    // No family keyword matches a Polish sentence — falls back to the default, not draft.
    expect(doc.status).toBe('current');
    expect(doc.body).toBe(PLAN_000_EXCERPT);
  });
});

describe('parseDocument: a strict-frontmatter note with wikilinks', () => {
  it('reads name as the title fallback, nested metadata.type, and preserves [[wikilinks]] verbatim', () => {
    const doc = parseDocument(
      MEMORY_NOTE_EXCERPT,
      '/Users/x/.claude/projects/-x/memory/a-lease-shorter-than-the-job-duplicates-the-work.md',
      'strict-frontmatter',
    );
    expect(doc.title).toBe('a-lease-shorter-than-the-job-duplicates-the-work');
    // metadata.type is "project", which is not one of the KB's six doc types — tolerant fallback.
    expect(doc.type).toBe('note');
    expect(doc.warnings).toEqual([]);
    expect(doc.body).toContain('[[d1-writes-cost-1000x-reads]]');
    expect(doc.body).toContain('[[cloudflare-observability-is-the-error-channel]]');
  });

  it('reports a missing frontmatter block that the markdown format would silently accept', () => {
    const raw = '# A note someone forgot to add frontmatter to\n\nJust prose.\n';
    const strict = parseDocument(raw, '/repo/x.md', 'strict-frontmatter');
    const lenient = parseDocument(raw, '/repo/x.md', 'markdown');
    expect(strict.warnings).toEqual(['strict-frontmatter: no YAML frontmatter block found']);
    expect(lenient.warnings).toEqual([]);
  });

  it('maps metadata.type through when it does match a known doc type', () => {
    const raw = '---\nname: x\nmetadata:\n  type: reference\n---\nBody.\n';
    const doc = parseDocument(raw, '/repo/x.md', 'strict-frontmatter');
    expect(doc.type).toBe('reference');
  });
});

describe('parseDocument: a bare .md with nothing at all', () => {
  it('falls all the way back to the filename stem and every default, without throwing', () => {
    const doc = parseDocument('', '/repo/knowledge/empty-note.md', 'markdown');
    expect(doc.title).toBe('empty-note');
    expect(doc.type).toBe('note');
    expect(doc.status).toBe('current');
    expect(doc.statusRaw).toBeUndefined();
    expect(doc.tags).toEqual([]);
    expect(doc.identifiers).toEqual([]);
    expect(doc.supersedes).toBeUndefined();
    expect(doc.links).toBeUndefined();
    expect(doc.source).toBeUndefined();
    expect(doc.body).toBe('');
    expect(doc.warnings).toEqual([]);
  });

  it('never throws on whitespace-only content either', () => {
    expect(() => parseDocument('   \n\n  \n', '/repo/knowledge/blank.md', 'markdown')).not.toThrow();
  });
});

describe('parseDocument: unknown format', () => {
  it('degrades silently to markdown behaviour', () => {
    const raw = '# Title\n\nBody.\n';
    const known = parseDocument(raw, '/repo/x.md', 'markdown');
    const unknown = parseDocument(raw, '/repo/x.md', 'not-a-real-format');
    expect(unknown).toEqual(known);
  });

  it('also degrades to markdown when format is entirely omitted', () => {
    const raw = '# Title\n\nBody.\n';
    expect(parseDocument(raw, '/repo/x.md')).toEqual(parseDocument(raw, '/repo/x.md', 'markdown'));
  });
});

describe('parseDocument: frontmatter field coercion', () => {
  it('accepts real YAML arrays for tags, identifiers, links and supersedes', () => {
    const raw =
      '---\n' +
      'tags: [architecture, agents]\n' +
      'identifiers: [SPEC-282, SPEC-283]\n' +
      'links: [scheduling-carve]\n' +
      'supersedes: [actors-over-core]\n' +
      'project: chat\n' +
      'supersededBy: product-capability-split\n' +
      'supersededAt: 2026-08-06\n' +
      '---\n' +
      'Body.\n';
    const doc = parseDocument(raw, '/repo/x.md', 'markdown');
    expect(doc.tags).toEqual(['architecture', 'agents']);
    expect(doc.identifiers).toEqual(['SPEC-282', 'SPEC-283']);
    expect(doc.links).toEqual(['scheduling-carve']);
    expect(doc.supersedes).toEqual(['actors-over-core']);
    expect(doc.project).toBe('chat');
    expect(doc.supersededBy).toBe('product-capability-split');
    expect(doc.supersededAt).toBe('2026-08-06');
  });

  it('also accepts a free-text comma list for tags, the bullet-meta/line-meta shape', () => {
    const raw = ['# Title', '', 'Tags: architecture, agents', ''].join('\n');
    const doc = parseDocument(raw, '/repo/x.md', 'line-meta');
    expect(doc.tags).toEqual(['architecture', 'agents']);
  });

  it('carries a well-formed source object through unchanged', () => {
    const raw =
      '---\n' +
      'source:\n' +
      '  kind: notion\n' +
      '  connectionId: conn_1\n' +
      '  externalId: ext_1\n' +
      '  url: https://example.invalid/p/1\n' +
      '  remoteVersion: v1\n' +
      '  origin: remote\n' +
      '  state: ok\n' +
      '  mirroredAt: 2026-08-06T11:55:00Z\n' +
      '---\n' +
      'Body.\n';
    const doc = parseDocument(raw, '/repo/x.md', 'markdown');
    expect(doc.source).toEqual({
      kind: 'notion',
      connectionId: 'conn_1',
      externalId: 'ext_1',
      url: 'https://example.invalid/p/1',
      remoteVersion: 'v1',
      origin: 'remote',
      state: 'ok',
      mirroredAt: '2026-08-06T11:55:00Z',
      lossy: [],
    });
    expect(doc.warnings).toEqual([]);
  });

  it('drops a source block that does not match the wire shape, with a warning, never fatal', () => {
    const raw = '---\nsource:\n  kind: notion\n---\nBody.\n';
    const doc = parseDocument(raw, '/repo/x.md', 'markdown');
    expect(doc.source).toBeUndefined();
    expect(doc.warnings).toEqual(['frontmatter "source" did not match the expected shape, ignoring']);
  });
});

describe('parseDocument: status family precedence', () => {
  it.each([
    ['superseded', 'superseded'],
    ['replaced by the new flow', 'superseded'],
    ['Obsolete', 'superseded'],
    ['deprecated in favour of v2', 'superseded'],
    ['Implemented', 'current'],
    ['done', 'current'],
    ['Shipped 2026-08-06', 'current'],
    ['Partial — phase 1 only', 'current'],
    ['proposed', 'draft'],
    ['Draft', 'draft'],
    ['WIP', 'draft'],
    ['planned for next quarter', 'draft'],
    ['some unrecognised sentence', 'current'],
  ] as const)('normalizes %j to %j', (raw, expected) => {
    const doc = parseDocument(`---\nstatus: "${raw}"\n---\nBody.\n`, '/repo/x.md', 'markdown');
    expect(doc.status).toBe(expected);
    expect(doc.statusRaw).toBe(raw);
  });
});
