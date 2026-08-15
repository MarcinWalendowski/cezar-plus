import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.ts';
import type { AgentRunner, RunnerId } from '../core/agent-runner.ts';
import { createRunner } from '../core/runner-factory.ts';
import { parseStructured } from '../planner.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import type { WorkspaceRunIndex } from '../workspace/run-index.ts';
import type { NoteCoordinator, NoteProjectEntry } from './coordinator.ts';
import type { NotePipelineFailure } from './pipeline.ts';
import {
  DIGEST_PER_PROJECT,
  MAX_PROPOSALS,
  NOTE_PASS_SYSTEM_PROMPT,
  NOTE_PASS_TIMEOUT_MS,
  buildNotePassPrompt,
  notePassResponseSchema,
  type NotePassResponse,
} from './prompt.ts';
import type { NoteStore } from './store.ts';
import type { StoredNote } from './types.ts';

/**
 * The triage pass (P2.2, spec `.ai/specs/2026-08-14-note-to-spec-pipeline.md`).
 *
 * One note in; N reviewable proposals out, each aimed at one registered project. This is the
 * cheap, wide half of the pipeline — the deep half is the per-project spec run that approval
 * starts, which happens INSIDE the target repository with full tool access.
 *
 * ## Two properties, both structural rather than careful
 *
 * 1. **This path never builds a `ProjectContext`.** It reads the registry, one workflows
 *    directory per project, and each project's `runs.json` through `WorkspaceRunIndex` — all
 *    plain file reads. Building a context calls `manager.recover()`, which resumes interrupted
 *    agent runs, so a cross-project read that built contexts would restart work in every
 *    registered repository as a side effect of typing a note. `./processor.test.ts` walks this
 *    module's transitive import graph and fails if `server/project-context.ts` or
 *    `workflows/run.ts` ever appears in it — transitively, because a one-file grep would be
 *    silenced by a single layer of indirection.
 * 2. **CORRECTED 2026-08-15 — the pass ASKS for no tools; it is not denied them.** This item
 *    used to read "**The pass has no tools** (`allowedTools: []`) … It cannot read a repository,
 *    so it cannot claim to have", and the second half is false on the Claude backend. Measured
 *    against `claude` 2.1.224, `--allowedTools` only grants additively and never restricts, so
 *    `allowedTools: []` denies nothing (`core/claude-cli-runner.ts`,
 *    `.ai/specs/2026-08-15-bypass-permissions-claude-sessions.md`). What still holds is the
 *    prompt: the pass is given a note, a catalog and a board digest and asked for JSON, and its
 *    `cwd` is the boot root rather than any target repository. What no longer holds is the
 *    STRUCTURAL claim — nothing stops a Claude run here from reading a file, so treat this as an
 *    intent, not a guarantee, until the runner emits `--disallowedTools` for the allow-list's
 *    complement (filed in that spec). Property 1 above is unaffected: it is enforced by an
 *    import-graph test, which is a real structural guard.
 *
 * The pass never creates anything. Approval does, on a human click.
 */

/** The proposals array as it is stored on a pass — spelled once so three signatures below do not
 *  each re-derive it. */
type NotePassProposals = NonNullable<StoredNote['pass']>['proposals'];

export interface NoteProcessorDeps {
  store: NoteStore;
  coordinator: NoteCoordinator;
  runIndex: WorkspaceRunIndex;
  /**
   * Where the pass's own agent call is configured from: the runner, the planner model and the
   * agent account it bills to all come from this root. The BOOT project — the repo `cezar serve`
   * was started in — because a workspace-level pass has no project of its own and the boot repo is
   * the one whose config the operator actually set. Intended as a configuration lookup rather
   * than a directory anything is read from — but see property 2 above: on the Claude backend
   * that is the prompt's intent, not something the runner enforces, so this root is also the
   * `cwd` a tool-using run could reach.
   */
  bootRoot: string;
  /** Defaults to the real `createRunner`. Injected so a test drives the pass with a scripted
   *  answer instead of spawning an agent CLI — the pass has no tools, so a fake here is a
   *  faithful stand-in for the whole of what the real runner does: text in, text out. */
  runnerFactory?: (backend: RunnerId) => AgentRunner;
  now?: () => Date;
  warn?: (message: string) => void;
}

export class NoteProcessor {
  private readonly now: () => Date;

  constructor(private readonly deps: NoteProcessorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Mark the note `processing` and answer; the pass itself runs detached.
   *
   * Detached because an agent call takes up to two minutes and a request must not be held open
   * for it — the contract says 202. The returned promise settles as soon as the status is written,
   * so the route's answer is proof the pass STARTED, never proof it finished.
   */
  async process(noteId: string): Promise<{ ok: true; note: StoredNote } | NotePipelineFailure> {
    const current = this.deps.store.get(noteId);
    if (!current) return { ok: false, status: 404, error: 'not found' };
    // A second click while a pass is in flight would run two agent calls over one note and let
    // whichever finished last overwrite the other's proposals.
    if (current.status === 'processing') {
      return { ok: false, status: 409, error: 'this note is already being analysed' };
    }

    const note = await this.deps.store.update(noteId, { status: 'processing' });
    if (!note) return { ok: false, status: 404, error: 'not found' };

    // Detached on purpose, and every failure is caught INSIDE `runPass` and written onto the note.
    // The extra `.catch` is the backstop for a throw from the catch path itself: an unhandled
    // rejection here would take the whole server down over one note.
    void this.runPass(note).catch((error) => {
      this.deps.warn?.(`The note pass crashed unexpectedly: ${describe(error)}`);
    });

    return { ok: true, note };
  }

  /** Exposed for tests, which need to await the pass rather than race it. */
  async runPass(note: StoredNote): Promise<void> {
    const passId = `pass_${randomUUID()}`;
    const startedAt = this.now().toISOString();
    const projects = await this.deps.coordinator.considered();
    const catalog = await this.deps.coordinator.catalog(projects);
    const digest = await this.deps.runIndex.digest(
      catalog.map((project) => project.id),
      DIGEST_PER_PROJECT,
    );
    const prompt = buildNotePassPrompt({
      note: {
        title: note.title,
        body: note.body,
        ...(note.projectHint ? { projectHint: note.projectHint } : {}),
      },
      catalog,
      digest,
    });

    const answer = await this.ask(prompt);
    if (!answer.ok) {
      await this.writePass(note.id, {
        id: passId,
        startedAt,
        finishedAt: this.now().toISOString(),
        runner: answer.runner,
        summary: '',
        proposals: this.degraded(note, catalog),
        unassigned: [],
        // `fallback` means "this is not what the pass would have said" — the review screen shows
        // it dimmed, and the error below says why. Zero proposals with a visible error is an
        // honest answer; zero proposals with no error would be the silent failure.
        fallback: true,
        truncated: false,
        consideredProjects: catalog.map((project) => project.id),
        boardDigestSize: countDigestEntries(digest),
        error: answer.error,
      }, 'failed');
      return;
    }

    const sanitized = sanitizeProposals(answer.data, catalog);
    await this.writePass(note.id, {
      id: passId,
      startedAt,
      finishedAt: this.now().toISOString(),
      runner: answer.runner,
      summary: answer.data.summary.slice(0, 4_000),
      proposals: sanitized.proposals,
      unassigned: sanitized.unassigned,
      fallback: false,
      truncated: sanitized.truncated,
      consideredProjects: catalog.map((project) => project.id),
      boardDigestSize: countDigestEntries(digest),
    }, 'processed');
  }

  /**
   * One agent call, one retry on an unparseable answer, then give up — `planChain`'s discipline
   * exactly. A runner error does NOT retry: the runner being absent or unauthenticated is not a
   * condition a second identical call improves, and this is a background pass nobody is watching.
   */
  private async ask(
    prompt: string,
  ): Promise<
    | { ok: true; data: NotePassResponse; runner: 'claude' | 'codex' | 'opencode' | 'pi' }
    | { ok: false; error: string; runner: 'claude' | 'codex' | 'opencode' | 'pi' }
  > {
    const config = await loadConfig(this.deps.bootRoot);
    const runnerId = config.defaultRunner;
    const runner = (this.deps.runnerFactory ?? createRunner)(runnerId);
    // Claude-only alias, same reason as `planChain`: Codex/OpenCode pick their own default model.
    const model = runnerId === 'claude' ? config.plannerModel : undefined;
    // Under the same agent account this workspace's tasks run on — otherwise a triage pass
    // quietly bills a personal subscription for a workspace pointed at a work account.
    const { env } = await resolveProfileEnvForRoot(this.deps.bootRoot, runnerId);

    let lastError = 'the runner returned nothing this pass could parse';
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      try {
        const result = await runner.run({
          systemPrompt: NOTE_PASS_SYSTEM_PROMPT,
          userPrompt: prompt,
          cwd: this.deps.bootRoot,
          // NO TOOLS. See property 2 in the module doc.
          allowedTools: [],
          ...(Object.keys(env).length > 0 ? { env } : {}),
          model,
          timeoutMs: NOTE_PASS_TIMEOUT_MS,
        });
        text = result.text;
      } catch (error) {
        return { ok: false, error: describe(error), runner: runnerId };
      }
      const parsed = parseStructured(text, notePassResponseSchema);
      if (parsed) return { ok: true, data: parsed, runner: runnerId };
    }
    return { ok: false, error: lastError, runner: runnerId };
  }

  /**
   * What a failed pass proposes: the whole note, at the project the person named — and NOTHING
   * when they named none.
   *
   * `planChain` can degrade to a one-step plan because it already knows which repository it is
   * planning for. Here the target is precisely what the pass was asked to work out, so a fallback
   * that picked a project would be inventing the one answer that matters. An empty list plus the
   * error on the pass is the truthful degradation.
   */
  private degraded(note: StoredNote, catalog: readonly NoteProjectEntry[]): NotePassProposals {
    const hinted = note.projectHint
      ? catalog.find((project) => project.id === note.projectHint)
      : undefined;
    if (!hinted) return [];
    return [
      {
        id: 'p1',
        projectId: hinted.id,
        title: note.title,
        task: note.body,
        rationale: 'The triage pass was unavailable, so this is the note as written.',
        issues: [],
        decision: 'pending' as const,
      },
    ];
  }

  private async writePass(
    noteId: string,
    pass: NonNullable<StoredNote['pass']>,
    status: StoredNote['status'],
  ): Promise<void> {
    await this.deps.store.update(noteId, {
      status,
      pass,
      processedAt: this.now().toISOString(),
    });
    this.deps.store.log({
      noteId,
      event: 'pass',
      passId: pass.id,
      detail: pass.error
        ? `failed: ${pass.error}`
        : `${pass.proposals.length} proposal(s) across ${new Set(pass.proposals.map((row) => row.projectId)).size} project(s)`,
    });
  }
}

/**
 * Turn the model's answer into proposals the review screen can trust.
 *
 * The rule throughout: **flag, never coerce, never silently drop.** A proposal naming a project
 * that does not exist keeps its text and gains an `unknown-project` issue rather than being
 * retargeted at the nearest plausible repo — retargeting would start an agent run in a repository
 * nobody chose. The only thing dropped is overflow past the contract's cap, and that is reported
 * as `truncated`.
 */
export function sanitizeProposals(
  answer: NotePassResponse,
  catalog: readonly NoteProjectEntry[],
): {
  proposals: NotePassProposals;
  unassigned: NonNullable<StoredNote['pass']>['unassigned'];
  truncated: boolean;
} {
  const byId = new Map(catalog.map((project) => [project.id, project] as const));
  const kept = answer.proposals.slice(0, MAX_PROPOSALS);

  const proposals = kept.map((row, index) => {
    const project = byId.get(row.projectId);
    const issues: NotePassProposals[number]['issues'] = [];
    if (!project) issues.push('unknown-project');
    // An unknown workflow is not fatal — approval falls back to `quick-task` — but it is worth
    // seeing, because it usually means the pass invented a name.
    if (project && row.workflow && !project.workflows.includes(row.workflow)) {
      issues.push('unknown-workflow');
    }
    return {
      id: `p${index + 1}`,
      projectId: row.projectId,
      title: row.title.slice(0, 200),
      task: row.task.slice(0, 100_000),
      rationale: row.rationale.slice(0, 2_000),
      ...(row.confidence ? { confidence: row.confidence } : {}),
      // Kept only when the project actually has it, so an invented name never reaches a run.
      ...(project && row.workflow && project.workflows.includes(row.workflow)
        ? { workflow: row.workflow }
        : {}),
      ...(row.duplicateOf
        ? {
            duplicateOf: {
              projectId: row.duplicateOf.projectId,
              ...(row.duplicateOf.runId ? { runId: row.duplicateOf.runId } : {}),
              title: row.duplicateOf.title.slice(0, 200),
              reason: row.duplicateOf.reason.slice(0, 500),
            },
          }
        : {}),
      issues,
      decision: 'pending' as const,
    };
  });

  return {
    proposals,
    unassigned: answer.unassigned.map((row) => ({
      text: row.text.slice(0, 2_000),
      reason: row.reason.slice(0, 500),
    })),
    truncated: answer.proposals.length > MAX_PROPOSALS,
  };
}

function countDigestEntries(digest: Record<string, { entries: unknown[] }>): number {
  return Object.values(digest).reduce((total, board) => total + board.entries.length, 0);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
