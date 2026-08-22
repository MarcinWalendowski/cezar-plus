import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "EVERY task carries an author" — the structural half of
 * `.ai/specs/2026-08-21-task-author-provenance.md`.
 *
 * `npm run typecheck` is the real enforcement: `author` is a REQUIRED key on `createRun`'s input,
 * on `StartRunInput` and on `createTodo`'s third parameter, so a creation site that names none
 * does not compile. This suite is the POSITIVE CONTROL on that check — the lesson of
 * `notion-178597643142`, *"a structural test that greps needs a positive control on what it
 * found"*: a guard that quietly matches nothing passes forever and proves nothing.
 *
 * So each case asserts first that it FOUND the sites it is about to judge, then that every one of
 * them names an author. A typecheck failure and this failing say the same thing twice, from two
 * directions — which is the point, because a future refactor that reintroduced a default would
 * silence the first while leaving this one red.
 */

const SRC = join(import.meta.dirname, '..');

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.testkit.ts')) {
      acc.push(path);
    }
  }
  return acc;
}

/** The text of one call, from `name(` to its balanced closing paren. */
function callsTo(source: string, name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start < 0) return out;
    let depth = 0;
    let i = start + needle.length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(start, i + 1));
    from = i + 1;
  }
}

describe('every task-creation site in src/ names an author', () => {
  const files = sourceFiles(SRC).filter((path) => !path.endsWith(join('runs', 'task-author.ts')));
  const sources = files.map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it('the sweep actually reads the server source — the positive control', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(join('runs', 'store.ts')))).toBe(true);
    expect(files.some((f) => f.endsWith(join('workflows', 'run.ts')))).toBe(true);
  });

  /**
   * A call is EXEMPT only when it forwards an already-typed `StartRunInput` / options object
   * whose `author` typecheck has already proved — never because it "looks fine". Each pattern is
   * spelled out so adding a ninth creation path cannot quietly land under one of them: a new
   * forwarder has to be added here deliberately, which is the review moment.
   */
  const forwardsATypedInput = (call: string): boolean =>
    // A declaration, not a call: `startVariants(workflow: WorkflowDef, input: StartRunInput, …)`.
    /\w+\s*:\s*(WorkflowDef|StartRunInput|ExecuteRunInput)\b/.test(call) ||
    // `{ ...input }` / `{ ...options }` — the spread carries the author with it.
    /\.\.\.\s*(input|options|effectiveInput|over)\b/.test(call) ||
    // `startRun(workflow, input)` — the argument IS the typed input.
    /\(\s*[\w.]+,\s*(input|effectiveInput)\s*(,|\))/.test(call) ||
    // `startRun(workflow, task, options)` / `startRun(workflow, task, await this.startOptions(run))`
    // — `notes/`'s two injected seams, whose options type carries a required `author`.
    /,\s*(options|await this\.startOptions\([^)]*\))\s*\)/.test(call);

  it('every `.createRun(` / `.startRun(` / `startVariants(` call passes an author', () => {
    const sites: Array<{ path: string; call: string }> = [];
    for (const { path, text } of sources) {
      for (const name of ['.createRun', '.startRun', 'startVariants']) {
        for (const call of callsTo(text, name)) sites.push({ path, call });
      }
    }
    // Positive control: the eight paths §Problem tabulated, plus the definitions and forwarders.
    expect(sites.length).toBeGreaterThan(8);

    const missing = sites.filter(({ call }) => !/\bauthor\b/.test(call) && !forwardsATypedInput(call));
    expect(missing.map((m) => `${m.path}: ${m.call.slice(0, 80)}`)).toEqual([]);
  });

  it('the exemption is narrow — a bare `startRun(workflow, { task })` is NOT forgiven', () => {
    // The negative control on the control: if `forwardsATypedInput` ever widened to the point of
    // accepting a plain object literal, the case above would pass while proving nothing.
    expect(forwardsATypedInput("manager.startRun(workflow, { task: 'x' })")).toBe(false);
    expect(forwardsATypedInput('store.createRun({ title: 1, steps: [] })')).toBe(false);
  });

  it('every `createTodo(` call passes an author as its third argument', () => {
    const sites: Array<{ path: string; call: string }> = [];
    for (const { path, text } of sources) {
      if (path.endsWith(join('src', 'todos.ts'))) continue; // the definition
      for (const call of callsTo(text, 'createTodo')) sites.push({ path, call });
    }
    // Positive control: the create route, the CLI, and the report-triage mint.
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const { path, call } of sites) {
      expect([path, /author/i.test(call)]).toEqual([path, true]);
    }
  });

  it('no creation site invents a default — `author` is never spelled with a fallback', () => {
    for (const { path, text } of sources) {
      expect([path, /author\s*(\?\?|\|\|)\s*/.test(text)]).toEqual([path, false]);
    }
  });

  it('`updateRun` / `updateTodo` never write an author — it is stamped once, never edited', () => {
    for (const { path, text } of sources) {
      for (const call of [...callsTo(text, 'updateRun'), ...callsTo(text, 'updateTodo')]) {
        expect([path, call.includes('author')]).toEqual([path, false]);
      }
      // `updateTodo`'s own patch type must not gain the key either.
      if (path.endsWith(join('src', 'todos.ts'))) {
        const patch = text.slice(text.indexOf('export type UpdateTodoPatch'));
        expect(patch.slice(0, patch.indexOf('};'))).not.toContain('author');
      }
    }
  });
});

describe('the env contract documents the two new variables', () => {
  const REPO_ROOT = join(import.meta.dirname, '../../../..');
  const envExample = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');

  it('.env.example names CEZ_STEP_ID and CEZ_SESSION_ID', () => {
    // `AGENTS.md`: `.env.example` is the env contract's single documentation surface, and a new
    // variable lands there in the SAME commit that introduces it.
    expect(envExample).toContain('CEZ_TASK_ID'); // positive control on the file being the right one
    expect(envExample).toContain('CEZ_STEP_ID');
    expect(envExample).toContain('CEZ_SESSION_ID');
  });

  it('documents them as cezar-set, not user-settable', () => {
    const line = envExample.indexOf('CEZ_STEP_ID');
    const section = envExample.slice(Math.max(0, line - 400), line);
    expect(section).toContain('set by cezar for child agent processes; you should not set them');
  });
});
