import { describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_PROTOCOL,
  clusterDispatchFrameSchema,
  clusterDispatchRefusalReasonSchema,
  type ClusterCorpusStatus,
  type ClusterDispatchFrame,
  type ClusterRepoFreshness,
} from '@loki-labs/cezar-plus-contract';
import {
  buildDispatch,
  DEFAULT_CORPUS_STALENESS_MS,
  dispatchRefusalReason,
  isCorpusStale,
  mayStartWithoutHub,
  offerDispatch,
  type BuildDispatchInput,
  type DispatchAcceptanceInput,
} from './dispatch.ts';

/**
 * Package 4.3 of `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md` — dispatch: building an
 * offer on the hub (`buildDispatch`), and refusing it on the spoke (`dispatchRefusalReason`,
 * `offerDispatch`, `isCorpusStale`, `mayStartWithoutHub`). Verifies spec `.ai/specs/2026-08-22-
 * multi-node-cezar-cluster.md` D11 (opt-in, spoke-enforced), D12a (workflow by value, freshness
 * refusal), D8a (corpus staleness refusal), D15a (offline autostart scope split) — automated 14
 * and 19, and the automatable half of E5a.
 */

// ---- fixtures -----------------------------------------------------------------------------

function freshFreshness(overrides: Partial<ClusterRepoFreshness> = {}): ClusterRepoFreshness {
  return {
    projectKey: 'proj-a',
    headSha: 'a'.repeat(40),
    ahead: 0,
    behind: 0,
    dirty: 0,
    merging: false,
    ...overrides,
  };
}

function freshCorpus(overrides: Partial<ClusterCorpusStatus> = {}): ClusterCorpusStatus {
  return {
    version: 'v1',
    fetchedAt: new Date().toISOString(),
    scope: ['knowledge'],
    quarantined: 0,
    ...overrides,
  };
}

function baseFrame(overrides: Partial<ClusterDispatchFrame> = {}): ClusterDispatchFrame {
  return {
    type: 'dispatch',
    protocol: CLUSTER_PROTOCOL,
    dispatchId: 'dispatch-1',
    todoId: 'todo-1',
    projectKey: 'proj-a',
    placement: {},
    workflow: { builtinId: 'quick-task' },
    ...overrides,
  };
}

function baseAcceptanceInput(
  overrides: Partial<DispatchAcceptanceInput> = {},
): DispatchAcceptanceInput {
  return {
    frame: baseFrame(),
    acceptsDispatch: true,
    paired: true,
    freshness: freshFreshness(),
    corpus: undefined,
    capacityAvailable: true,
    ...overrides,
  };
}

// ---- buildDispatch --------------------------------------------------------------------------

describe('buildDispatch — the hub builds an offer', () => {
  const input: BuildDispatchInput = {
    todoId: 'todo-1',
    projectKey: 'proj-a',
    placement: { node: 'node-b' },
    targetNodeId: 'node-b',
    workflow: { builtinId: 'quick-task' },
  };

  it('builds a frame that validates against the wire schema', async () => {
    const frame = await buildDispatch(input);
    expect(() => clusterDispatchFrameSchema.parse(frame)).not.toThrow();
    expect(frame.type).toBe('dispatch');
    expect(frame.protocol).toEqual(CLUSTER_PROTOCOL);
    expect(frame.todoId).toBe('todo-1');
    expect(frame.projectKey).toBe('proj-a');
    expect(frame.placement).toEqual({ node: 'node-b' });
    expect(frame.workflow).toEqual({ builtinId: 'quick-task' });
  });

  it('mints a distinct dispatchId per call', async () => {
    const a = await buildDispatch(input);
    const b = await buildDispatch(input);
    expect(a.dispatchId).not.toBe(b.dispatchId);
  });

  it('carries expect.headSha only when the caller supplied one', async () => {
    const withExpect = await buildDispatch({ ...input, expectHeadSha: 'c'.repeat(40) });
    expect(withExpect.expect).toEqual({ headSha: 'c'.repeat(40) });

    const withoutExpect = await buildDispatch(input);
    expect(withoutExpect.expect).toBeUndefined();
  });

  it('carries override only when a human set it', async () => {
    const withOverride = await buildDispatch({ ...input, override: true });
    expect(withOverride.override).toBe(true);

    const withoutOverride = await buildDispatch(input);
    expect(withoutOverride.override).toBeUndefined();
  });

  // E5a, half one (workflow-by-value): a workflow that exists only on the dispatching node still
  // has to reach the target intact — carried inline, never as a name the target must resolve.
  it('E5a: carries an inline workflow definition byte-identical (D12a — by value, never by name)', async () => {
    const def = {
      name: 'only-on-the-dispatching-node',
      steps: [{ id: 'step-1', prompt: 'do the thing' }],
      source: 'file' as const,
    };
    const frame = await buildDispatch({ ...input, workflow: { def } });
    expect(frame.workflow).toEqual({ def });
    // Nothing about acceptance below ever looks the workflow up by name — see
    // `offerDispatch`'s own tests: it accepts or refuses without consulting any local registry.
  });
});

// ---- isCorpusStale ---------------------------------------------------------------------------

describe('isCorpusStale', () => {
  it('is never stale when the node mirrors nothing at all (opted-out is not the same state as stale)', () => {
    expect(isCorpusStale(undefined)).toBe(false);
  });

  it('is not stale within the bound', () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const corpus = freshCorpus({
      fetchedAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
    });
    expect(isCorpusStale(corpus, { now: () => now })).toBe(false);
  });

  it('is stale past the default bound', () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const corpus = freshCorpus({
      fetchedAt: new Date(now.getTime() - (DEFAULT_CORPUS_STALENESS_MS + 60_000)).toISOString(),
    });
    expect(isCorpusStale(corpus, { now: () => now })).toBe(true);
  });

  it('honours a caller-supplied bound instead of the default', () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const corpus = freshCorpus({
      fetchedAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    });
    expect(isCorpusStale(corpus, { boundMs: 60_000, now: () => now })).toBe(true);
    expect(isCorpusStale(corpus, { boundMs: 10 * 60 * 1000, now: () => now })).toBe(false);
  });

  it('treats an unparsable fetch stamp as stale, never as fresh', () => {
    const corpus = freshCorpus({ fetchedAt: 'not-a-date' });
    expect(isCorpusStale(corpus)).toBe(true);
  });
});

// ---- dispatchRefusalReason — the refusals, each naming itself ------------------------------

describe('dispatchRefusalReason', () => {
  it('accepts (returns undefined) when every check clears', () => {
    expect(dispatchRefusalReason(baseAcceptanceInput())).toBeUndefined();
  });

  // 1. D11 — acceptsDispatch is opt-in, defaults off, and enforced SPOKE-side.
  describe('opt-in refusal (D11)', () => {
    it('refuses dispatch-not-accepted when this node has not opted in', () => {
      expect(dispatchRefusalReason(baseAcceptanceInput({ acceptsDispatch: false }))).toBe(
        'dispatch-not-accepted',
      );
    });

    it('is NOT bypassed by a human override — override overrides a freshness refusal, never the opt-in', () => {
      expect(
        dispatchRefusalReason(
          baseAcceptanceInput({
            acceptsDispatch: false,
            frame: baseFrame({ override: true }),
          }),
        ),
      ).toBe('dispatch-not-accepted');
    });
  });

  it('refuses unpaired-project when the project is not paired with this node', () => {
    expect(dispatchRefusalReason(baseAcceptanceInput({ paired: false }))).toBe('unpaired-project');
  });

  // 3. Pre-dispatch freshness refusal (D12a): behind, dirty, or mid-conflict, naming which.
  describe('freshness refusal (D12a)', () => {
    it('refuses merging when the checkout is mid-conflict', () => {
      expect(
        dispatchRefusalReason(baseAcceptanceInput({ freshness: freshFreshness({ merging: true }) })),
      ).toBe('merging');
    });

    it('refuses behind when the checkout trails origin', () => {
      expect(
        dispatchRefusalReason(baseAcceptanceInput({ freshness: freshFreshness({ behind: 3 }) })),
      ).toBe('behind');
    });

    it('refuses dirty when the checkout has uncommitted changes', () => {
      expect(
        dispatchRefusalReason(baseAcceptanceInput({ freshness: freshFreshness({ dirty: 2 }) })),
      ).toBe('dirty');
    });

    it('negative control: a clean, up-to-date checkout is never refused on freshness grounds', () => {
      expect(
        dispatchRefusalReason(baseAcceptanceInput({ freshness: freshFreshness() })),
      ).toBeUndefined();
    });

    it('a human override bypasses a freshness refusal', () => {
      expect(
        dispatchRefusalReason(
          baseAcceptanceInput({
            freshness: freshFreshness({ behind: 5 }),
            frame: baseFrame({ override: true }),
          }),
        ),
      ).toBeUndefined();
    });

    // E5a, half two: the target's checkout is deliberately behind AND mid-conflict — dispatch
    // refuses and names WHICH, and the override runs it anyway.
    it('E5a: a target behind AND mid-conflict refuses, naming the worse fault (merging)', () => {
      expect(
        dispatchRefusalReason(
          baseAcceptanceInput({
            freshness: freshFreshness({ behind: 5, dirty: 1, merging: true }),
          }),
        ),
      ).toBe('merging');
    });

    it('E5a: the override runs a behind-and-mid-conflict target', () => {
      expect(
        dispatchRefusalReason(
          baseAcceptanceInput({
            freshness: freshFreshness({ behind: 5, dirty: 1, merging: true }),
            frame: baseFrame({ override: true }),
          }),
        ),
      ).toBeUndefined();
    });
  });

  // 4. Stale corpus refusal (D8a, verification 19) — with the mandatory negative control.
  describe('corpus staleness refusal (D8a, verification 19)', () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const staleCorpus = freshCorpus({
      fetchedAt: new Date(now.getTime() - (DEFAULT_CORPUS_STALENESS_MS + 60_000)).toISOString(),
    });
    const freshMirror = freshCorpus({ fetchedAt: now.toISOString() });

    it('19: a mirror stale past its bound refuses the dispatch, naming the corpus', () => {
      expect(
        dispatchRefusalReason(baseAcceptanceInput({ corpus: staleCorpus, now: () => now })),
      ).toBe('corpus-stale');
    });

    it('19, negative control: a FRESH mirror does not refuse (else the test would pass against a node that refuses everything)', () => {
      expect(
        dispatchRefusalReason(baseAcceptanceInput({ corpus: freshMirror, now: () => now })),
      ).toBeUndefined();
    });

    it('a node with no mirror at all is not refused on corpus grounds (never opted in ≠ stale)', () => {
      expect(
        dispatchRefusalReason(baseAcceptanceInput({ corpus: undefined, now: () => now })),
      ).toBeUndefined();
    });

    it('a human freshness override does NOT bypass a stale corpus — a different risk than "old checkout"', () => {
      expect(
        dispatchRefusalReason(
          baseAcceptanceInput({
            corpus: staleCorpus,
            now: () => now,
            frame: baseFrame({ override: true }),
          }),
        ),
      ).toBe('corpus-stale');
    });
  });

  it('refuses at-capacity when nothing else is wrong', () => {
    expect(dispatchRefusalReason(baseAcceptanceInput({ capacityAvailable: false }))).toBe(
      'at-capacity',
    );
  });
});

// ---- offerDispatch: the spoke's whole answer ------------------------------------------------

describe('offerDispatch — check, then start or refuse', () => {
  it('accepts, echoing the dispatch attempt id — never a minted run id', async () => {
    const outcome = await offerDispatch(baseAcceptanceInput());
    expect(outcome.accepted).toBe(true);
    // Mirrors input.frame.dispatchId exactly: this module never mints a run id (the caller does,
    // via RunManager.startRun, only after reading accepted: true here).
    expect(outcome.dispatchId).toBe('dispatch-1');
    expect(outcome.reply.type).toBe('freshness');
    expect(outcome.reply.refused).toBeUndefined();
  });

  it('refuses, still echoing the attempt id, naming the reason on the reply frame', async () => {
    const outcome = await offerDispatch(baseAcceptanceInput({ acceptsDispatch: false }));
    expect(outcome.accepted).toBe(false);
    // An attempt id exists even when no run ever starts — refused, in this case.
    expect(outcome.dispatchId).toBe('dispatch-1');
    expect(outcome.reply.refused).toEqual(
      expect.objectContaining({ reason: 'dispatch-not-accepted', dispatchId: 'dispatch-1' }),
    );
    expect(outcome.reply.refused?.detail).toBeTruthy();
  });

  it('the outcome dispatchId always matches the offer it answers, on both branches', async () => {
    const frame = baseFrame({ dispatchId: 'dispatch-xyz' });
    const accepted = await offerDispatch(baseAcceptanceInput({ frame }));
    expect(accepted.dispatchId).toBe('dispatch-xyz');

    const refused = await offerDispatch(
      baseAcceptanceInput({ frame, acceptsDispatch: false }),
    );
    expect(refused.dispatchId).toBe('dispatch-xyz');
  });

  it('19 (offerDispatch level): a stale corpus refuses with a detail naming the corpus', async () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const staleCorpus = freshCorpus({
      fetchedAt: new Date(now.getTime() - (DEFAULT_CORPUS_STALENESS_MS + 60_000)).toISOString(),
    });
    const outcome = await offerDispatch(
      baseAcceptanceInput({ corpus: staleCorpus, now: () => now }),
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.reply.refused?.reason).toBe('corpus-stale');
    expect(outcome.reply.refused?.detail).toMatch(/corpus/i);
  });

  it('19 (offerDispatch level), negative control: a fresh mirror is accepted, not refused', async () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const freshMirror = freshCorpus({ fetchedAt: now.toISOString() });
    const outcome = await offerDispatch(
      baseAcceptanceInput({ corpus: freshMirror, now: () => now }),
    );
    expect(outcome.accepted).toBe(true);
    expect(outcome.reply.refused).toBeUndefined();
  });

  it('reports a refusal through options.warn when provided', async () => {
    const warn = vi.fn();
    await offerDispatch(baseAcceptanceInput({ acceptsDispatch: false }), { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('dispatch-1');
  });

  it('does not call warn when the offer is accepted', async () => {
    const warn = vi.fn();
    await offerDispatch(baseAcceptanceInput(), { warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('the reply always reports the repo facts it was given, on both branches', async () => {
    const freshness = freshFreshness({ ahead: 2, behind: 0, dirty: 0, merging: false });
    const accepted = await offerDispatch(baseAcceptanceInput({ freshness }));
    expect(accepted.reply).toMatchObject({ ahead: 2, behind: 0, dirty: 0, merging: false });

    const refusedFreshness = freshFreshness({ ahead: 2, behind: 4, dirty: 0, merging: false });
    const refused = await offerDispatch(baseAcceptanceInput({ freshness: refusedFreshness }));
    expect(refused.reply).toMatchObject({ ahead: 2, behind: 4, dirty: 0, merging: false });
  });
});

// ---- mayStartWithoutHub — D15a's scope split, verification 14 ------------------------------

describe('mayStartWithoutHub — verification 14', () => {
  // 14, half one: hub unreachable at dispatch → a run a person starts by hand still starts.
  it('14, half one: a human-triggered start proceeds regardless of authorship', () => {
    expect(mayStartWithoutHub({ trigger: 'human', authoredHere: false })).toEqual({
      allowed: true,
    });
    expect(mayStartWithoutHub({ trigger: 'human', authoredHere: true })).toEqual({
      allowed: true,
    });
  });

  it('autostarting a todo this node authored proceeds — it was never anyone else\'s to start', () => {
    expect(mayStartWithoutHub({ trigger: 'autostart', authoredHere: true })).toEqual({
      allowed: true,
    });
  });

  // 14, half two: a REPLICATED todo's autostart refuses with a stated reason.
  it('14, half two: autostarting a replicated todo refuses with a stated reason', () => {
    expect(mayStartWithoutHub({ trigger: 'autostart', authoredHere: false })).toEqual({
      allowed: false,
      reason: 'waiting for the hub to confirm the claim',
    });
  });

  /**
   * **Two members of `clusterDispatchRefusalReasonSchema` have no emitter here, for two different
   * reasons — do not conflate them when this test next changes.**
   *
   * `unknown-workflow` is a TEMPORARY, closable gap and this half is a tripwire, not a property:
   * `dispatchRefusalReason` deliberately cannot decide it (its input carries no workflow validity,
   * by design — the definition is re-validated against `workflowDefSchema` on arrival by whichever
   * module resolves and runs it), and that module does not exist yet. **When arrival validation
   * lands, drop `unknown-workflow` from `emittable` below and add a case proving it IS produced —
   * do not just delete the whole test.**
   *
   * `start-failed` (D48) is PERMANENT, by construction, and will never move to the emitted side no
   * matter what else gets built: `dispatchRefusalReason`'s own doc comment is that it is "checked
   * before anything below has any side effect", and `start-failed` names a run that was ATTEMPTED
   * and threw — a fact that exists only after this function's decision is already `undefined`
   * (accepted) and the caller went on to call `startRun`. This function has no side channel to that
   * outcome (`DispatchAcceptanceInput` carries no thrown-error field, nor should it), so no case
   * added here could ever legitimately produce it.
   *
   * Either way: a wire enum member with no emitter and no note reads to the next author as a case
   * already handled. This test is the note, for both.
   */
  it('nothing here emits `unknown-workflow` or `start-failed` — both are in the enum with no emitter here', () => {
    expect(clusterDispatchRefusalReasonSchema.options).toContain('unknown-workflow');
    expect(clusterDispatchRefusalReasonSchema.options).toContain('start-failed');

    const cases: DispatchAcceptanceInput[] = [
      baseAcceptanceInput(),
      baseAcceptanceInput({ acceptsDispatch: false }),
      baseAcceptanceInput({ paired: false }),
      baseAcceptanceInput({ freshness: freshFreshness({ merging: true }) }),
      baseAcceptanceInput({ freshness: freshFreshness({ behind: 3 }) }),
      baseAcceptanceInput({ freshness: freshFreshness({ dirty: 2 }) }),
      baseAcceptanceInput({ corpus: freshCorpus({ fetchedAt: new Date(0).toISOString() }) }),
      baseAcceptanceInput({ capacityAvailable: false }),
      // A frame naming a workflow this node has never heard of — the input that WOULD produce it if
      // anything validated the definition. It does not; it is accepted.
      baseAcceptanceInput({ frame: baseFrame({ workflow: { builtinId: 'no-such-workflow' } }) }),
    ];
    const produced = cases.map((c) => dispatchRefusalReason(c));
    expect(produced).not.toContain('unknown-workflow');
    expect(produced).not.toContain('start-failed');

    // Floor, and it is the exact one: without it this passes against a `dispatchRefusalReason` that
    // returns `undefined` for everything, where "never unknown-workflow/start-failed" would be
    // worthless because nothing was refused at all. The cases above produce EVERY member of the
    // enum except those two — so this asserts the set difference, not a count that drifts. Add a
    // reason to the enum without an emitter and this goes red naming it, which is the whole point.
    const named = new Set(produced.filter((r): r is NonNullable<typeof r> => r !== undefined));
    const emittable = clusterDispatchRefusalReasonSchema.options.filter(
      (r) => r !== 'unknown-workflow' && r !== 'start-failed',
    );
    expect([...named].sort()).toEqual([...emittable].sort());
  });
});
