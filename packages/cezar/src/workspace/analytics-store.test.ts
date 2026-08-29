import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyticsDayKey,
  analyticsEnabled,
  analyticsFilePath,
  appendAnalyticsEvents,
} from './analytics-store.ts';

/** The sink's own rules (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, D7): the day file,
 *  the retention prune, and the promise that a failure is never fatal. */

const savedHome = process.env.CEZ_HOME;
const savedFlag = process.env.CEZ_ANALYTICS;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-analytics-store-'));
  process.env.CEZ_HOME = home;
  delete process.env.CEZ_ANALYTICS;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.CEZ_HOME;
  else process.env.CEZ_HOME = savedHome;
  if (savedFlag === undefined) delete process.env.CEZ_ANALYTICS;
  else process.env.CEZ_ANALYTICS = savedFlag;
});

const AT = new Date('2026-08-25T13:00:00.000Z');

describe('analytics store', () => {
  it('names the file for the SERVER day in UTC, not for the event ts', () => {
    expect(analyticsDayKey(AT)).toBe('2026-08-25');
    // An event claiming a different day is written into TODAY's file: a client with a wrong (or
    // crafted) clock must not be able to write into a file the pruner already passed.
    appendAnalyticsEvents([{ event: 'e', ts: '1999-01-01T00:00:00.000Z' }], { at: AT });
    expect(existsSync(analyticsFilePath(AT))).toBe(true);
    expect(existsSync(join(home, 'analytics', '1999-01-01.ndjson'))).toBe(false);
  });

  it('prunes day files older than 30 days and leaves everything inside the window', () => {
    const dir = join(home, 'analytics');
    mkdirSync(dir, { recursive: true });
    const old = '2026-07-01.ndjson'; // 55 days before AT
    const edge = '2026-07-26.ndjson'; // exactly the cutoff day — kept
    const recent = '2026-08-24.ndjson';
    const unrelated = 'notes.txt'; // not a day file: never touched
    for (const name of [old, edge, recent, unrelated]) writeFileSync(join(dir, name), 'x\n');

    appendAnalyticsEvents([{ event: 'e', ts: AT.toISOString() }], { at: AT });

    expect(existsSync(join(dir, old))).toBe(false);
    expect(existsSync(join(dir, edge))).toBe(true);
    expect(existsSync(join(dir, recent))).toBe(true);
    expect(existsSync(join(dir, unrelated))).toBe(true);
  });

  it('an empty batch writes nothing and creates no directory', () => {
    expect(appendAnalyticsEvents([], { at: AT })).toBe(0);
    expect(existsSync(join(home, 'analytics'))).toBe(false);
  });

  it('CEZ_ANALYTICS=0 disables it; anything else — including unset — is on', () => {
    expect(analyticsEnabled({})).toBe(true);
    expect(analyticsEnabled({ CEZ_ANALYTICS: '1' })).toBe(true);
    expect(analyticsEnabled({ CEZ_ANALYTICS: 'yes' })).toBe(true);
    expect(analyticsEnabled({ CEZ_ANALYTICS: '0' })).toBe(false);
    process.env.CEZ_ANALYTICS = '0';
    expect(appendAnalyticsEvents([{ event: 'e', ts: AT.toISOString() }], { at: AT })).toBe(0);
    expect(existsSync(join(home, 'analytics'))).toBe(false);
  });

  it('a write that cannot happen returns 0 instead of throwing', () => {
    // The analytics directory path is occupied by a FILE, so `mkdirSync` cannot create it. The
    // sink must swallow that: a full or hostile disk cannot be allowed to fail the page it
    // measures.
    writeFileSync(join(home, 'analytics'), 'not a directory');
    expect(appendAnalyticsEvents([{ event: 'e', ts: AT.toISOString() }], { at: AT })).toBe(0);
  });

  it('props default to an empty object rather than being absent, so every line has the same shape', () => {
    appendAnalyticsEvents([{ event: 'e', ts: AT.toISOString() }], { at: AT });
    const line = readFileSync(analyticsFilePath(AT), 'utf8').trim();
    expect(JSON.parse(line)).toEqual({ event: 'e', ts: AT.toISOString(), props: {} });
  });
});
