import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceGrant,
  dedupeContainedRoots,
  loadWorkspaceGrant,
  workspaceGrantSystemPrompt,
  type GrantedProject,
} from './granted-roots.ts';

/**
 * The directory grant behind a workspace run (`.ai/specs/2026-08-15-cross-project-workspace-run.md`).
 *
 * Every case here is about a rule that fails SILENTLY in production if it regresses: an over-broad
 * root set still works (just imprecisely), a missing prompt block still works on Claude (just not
 * on codex/opencode), and a `--add-dir` on a moved checkout fails at spawn with an error that names
 * a path, not a cause. So each assertion below names the value, not just its presence.
 */

function project(id: string, root: string, status: GrantedProject['status'] = 'ok'): GrantedProject {
  return { id, name: id, root, status };
}

describe('dedupeContainedRoots', () => {
  it("drops a root that lies inside another, keeping only the parent", () => {
    expect(
      dedupeContainedRoots([
        '/home/u/monorepo',
        '/home/u/monorepo/cezar',
        '/home/u/monorepo/chat',
        '/home/u/other/tools',
      ]),
    ).toEqual(['/home/u/monorepo', '/home/u/other/tools']);
  });

  it('collapses the owner-shaped registry from twelve roots to two', () => {
    // The measured shape of `~/.cezar/config.json` on 2026-08-15: `monorepo` plus ten of its own
    // subdirectories, plus one outlier. A mutation returning the input unfiltered gives 12.
    const registry = [
      '/home/u/other/tools',
      '/home/u/monorepo',
      '/home/u/monorepo/anymail-mcp',
      '/home/u/monorepo/aside',
      '/home/u/monorepo/bubble-trade',
      '/home/u/monorepo/career',
      '/home/u/monorepo/career-kit',
      '/home/u/monorepo/cezar',
      '/home/u/monorepo/chat',
      '/home/u/monorepo/chat-wt-spec-101',
      '/home/u/monorepo/homebrew-tap',
      '/home/u/monorepo/mw-site',
    ];
    expect(dedupeContainedRoots(registry)).toHaveLength(2);
  });

  it('compares whole segments — a shared prefix is not containment', () => {
    // `/a/bc` is NOT inside `/a/b`. A bare `startsWith` says it is, and silently narrows the grant
    // so the agent cannot write in a project the user registered.
    expect(dedupeContainedRoots(['/a/b', '/a/bc'])).toEqual(['/a/b', '/a/bc']);
  });

  it('collapses exact duplicates and ignores a trailing separator', () => {
    expect(dedupeContainedRoots(['/a/b', '/a/b/', '/a/b'])).toEqual(['/a/b']);
  });
});

describe('buildWorkspaceGrant', () => {
  it('grants no root for a project that is not on disk, but still lists it', () => {
    // `--add-dir` on a path that does not exist fails the SPAWN — one moved checkout would kill
    // every workspace run. Dropping it from `projects` too would hide that from the user.
    const grant = buildWorkspaceGrant([
      project('here', '/w/here'),
      project('gone', '/w/gone', 'missing'),
    ]);
    expect(grant.roots).toEqual(['/w/here']);
    expect(grant.projects.map((p) => p.id)).toEqual(['here', 'gone']);
  });

  it('grants a root for a non-git or commitless project', () => {
    // Neither status means "not on disk" — a plain directory is a perfectly good place to work,
    // and a workspace run has no worktree to need a repo for.
    const grant = buildWorkspaceGrant([
      project('plain', '/w/plain', 'not-git'),
      project('fresh', '/w/fresh', 'no-commits'),
    ]);
    expect(grant.roots).toEqual(['/w/fresh', '/w/plain']);
  });
});

describe('buildWorkspaceGrant — isolated (per-project worktrees, spec 2026-08-19)', () => {
  const wt = (root: string, worktreePath: string) => ({
    root,
    worktreePath,
    branch: 'cez/abcd1234',
    baseBranch: 'main',
  });

  it('grants the WORKTREE path, not the real checkout, for a project that has one', () => {
    // The whole point: --add-dir must point at the isolated worktree so N runs never collide.
    const grant = buildWorkspaceGrant(
      [project('cezar', '/w/cezar'), project('chat', '/w/chat')],
      [wt('/w/cezar', '/w/cezar/.ai/cezar/worktrees/r1'), wt('/w/chat', '/w/chat/.ai/cezar/worktrees/r1')],
    );
    expect(grant.isolated).toBe(true);
    expect(new Set(grant.roots)).toEqual(
      new Set(['/w/cezar/.ai/cezar/worktrees/r1', '/w/chat/.ai/cezar/worktrees/r1']),
    );
  });

  it('falls back to the real root for a project that has no worktree (non-git / failed)', () => {
    const grant = buildWorkspaceGrant(
      [project('cezar', '/w/cezar'), project('plain', '/w/plain', 'not-git')],
      [wt('/w/cezar', '/w/cezar/.ai/cezar/worktrees/r1')],
    );
    expect(new Set(grant.roots)).toEqual(
      new Set(['/w/cezar/.ai/cezar/worktrees/r1', '/w/plain']),
    );
  });

  it('maps a sibling registry entry to its SUBDIRECTORY of the shared repo worktree', () => {
    // `brand` and `chatbox` live inside the `monorepo` checkout and are registered as
    // projects of their own, so the run has ONE worktree for all three (spec 2026-08-20, X1).
    // Each still needs a path of its own, or the prompt would send two of them at the REAL
    // checkout — a silent isolation leak, which is exactly what the collapse was meant to close.
    const grant = buildWorkspaceGrant(
      [
        project('monorepo', '/w/mono'),
        project('brand', '/w/mono/brand'),
        project('chatbox', '/w/mono/chatbox'),
        project('cezar', '/w/mono/cezar'),
      ],
      [wt('/w/mono', '/w/mono/.ai/cezar/worktrees/r1'), wt('/w/mono/cezar', '/w/mono/cezar/.ai/cezar/worktrees/r1')],
    );
    expect(grant.paths.get('/w/mono')).toBe('/w/mono/.ai/cezar/worktrees/r1');
    expect(grant.paths.get('/w/mono/brand')).toBe('/w/mono/.ai/cezar/worktrees/r1/brand');
    expect(grant.paths.get('/w/mono/chatbox')).toBe(
      '/w/mono/.ai/cezar/worktrees/r1/chatbox',
    );
    // A nested repo with a worktree of its OWN wins over its container's — deepest root, not first.
    expect(grant.paths.get('/w/mono/cezar')).toBe('/w/mono/cezar/.ai/cezar/worktrees/r1');
    // The repo root is granted, so an agent can still work at the top of the repo; the three
    // sibling paths inside it collapse to that one `--add-dir`.
    expect(new Set(grant.roots)).toEqual(
      new Set(['/w/mono/.ai/cezar/worktrees/r1', '/w/mono/cezar/.ai/cezar/worktrees/r1']),
    );
  });

  it('does not mistake a shared prefix for containment', () => {
    // `/w/monorepo` is NOT inside `/w/mono`. A bare `startsWith` says it is and would grant a
    // path inside the wrong repo's worktree.
    const grant = buildWorkspaceGrant(
      [project('other', '/w/monorepo')],
      [wt('/w/mono', '/w/mono/.ai/cezar/worktrees/r1')],
    );
    expect(grant.paths.get('/w/monorepo')).toBe('/w/monorepo');
  });

  it('states that the knowledge mount is shared and real-pathed, and is not written directly', () => {
    // X5: the KB roots are the ONE grant that is not worktreed — they are handed to every
    // concurrent run at their real path. That is safe only because writes go to a per-run
    // `CEZ_KB_WRITE_FILE`, which is a convention an agent follows, not a boundary. Saying the
    // paths above are isolated without saying this one is not is what makes it dangerous.
    const grant = buildWorkspaceGrant(
      [project('cezar', '/w/cezar')],
      [wt('/w/cezar', '/w/cezar/.ai/cezar/worktrees/r1')],
    );
    const prompt = workspaceGrantSystemPrompt(grant) ?? '';
    expect(prompt).toMatch(/knowledge-base directories are NOT worktreed/i);
    expect(prompt).toMatch(/SHARED with every other run/i);
    expect(prompt).toContain('CEZ_KB_WRITE_FILE');
  });

  it('the prompt names the worktree paths and tells the agent cezar applies them back', () => {
    const grant = buildWorkspaceGrant(
      [project('cezar', '/w/cezar')],
      [wt('/w/cezar', '/w/cezar/.ai/cezar/worktrees/r1')],
    );
    const prompt = workspaceGrantSystemPrompt(grant) ?? '';
    expect(prompt).toContain('/w/cezar/.ai/cezar/worktrees/r1');
    expect(prompt).toMatch(/ISOLATED git worktree/i);
    expect(prompt).toMatch(/applies your changes back/i);
    expect(prompt).toMatch(/do\s+NOT commit/i);
  });
});

describe('workspaceGrantSystemPrompt', () => {
  const grant = buildWorkspaceGrant([
    project('cezar', '/home/u/monorepo/cezar'),
    project('mw-site', '/home/u/monorepo/mw-site'),
    project('gone', '/w/gone', 'missing'),
  ]);

  it('is not isolated (real checkouts) when no worktrees are given', () => {
    expect(grant.isolated).toBe(false);
    expect(workspaceGrantSystemPrompt(grant)).not.toMatch(/ISOLATED git worktree/i);
  });

  it('names every reachable project by ABSOLUTE path', () => {
    // The portable half: this text is all a codex/opencode run ever sees of the grant, and the
    // only thing that tells any backend where the work is — the cwd holds none of it.
    const prompt = workspaceGrantSystemPrompt(grant) ?? '';
    expect(prompt).toContain('/home/u/monorepo/cezar');
    expect(prompt).toContain('/home/u/monorepo/mw-site');
  });

  it('says a missing project is unreachable rather than listing it as a place to work', () => {
    const prompt = workspaceGrantSystemPrompt(grant) ?? '';
    expect(prompt).toContain('not on disk right now');
    expect(prompt).not.toContain('- gone: /w/gone');
  });

  it('tells the agent not to commit, because there is no worktree between it and the user', () => {
    // Not decoration: every edit lands in the real working tree beside whatever the user had in
    // progress, so a helpful `git commit -am` commits someone else's work.
    expect(workspaceGrantSystemPrompt(grant)).toMatch(/do\s+NOT commit/i);
  });

  it('is undefined when nothing is reachable, rather than claiming an empty workspace', () => {
    expect(workspaceGrantSystemPrompt(buildWorkspaceGrant([]))).toBeUndefined();
    expect(
      workspaceGrantSystemPrompt(buildWorkspaceGrant([project('gone', '/w/gone', 'missing')])),
    ).toBeUndefined();
  });
});

describe('loadWorkspaceGrant', () => {
  it('reads the registry it is given and builds the grant from it', async () => {
    const grant = await loadWorkspaceGrant(
      (async () => [
        { id: 'a', name: 'Alpha', root: '/w/a', status: 'ok' },
        { id: 'b', name: '', root: '/w/a/b', status: 'ok' },
      ]) as unknown as typeof import('./projects.ts').listProjects,
    );
    expect(grant.roots).toEqual(['/w/a']);
    expect(workspaceGrantSystemPrompt(grant)).toContain('- Alpha: /w/a');
    // A project with no name falls back to its slug rather than rendering an empty bullet.
    expect(workspaceGrantSystemPrompt(grant)).toContain('- b: /w/a/b');
  });
});
