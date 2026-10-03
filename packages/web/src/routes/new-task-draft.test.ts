import { afterEach, describe, expect, it } from 'vitest'

import type { PendingAttachment } from '@/components/composer/composer-attachments'

import {
  clearStartedDraft,
  clearDraftText,
  composerRunModeNote,
  handOffComposition,
  normalizeDispatchIntent,
  readAttachments,
  readDraft,
  resetDraft,
  resolveComposerRunMode,
  writeAttachments,
  writeDraft,
} from './new-task-draft'

afterEach(resetDraft)

const EMPTY_DRAFT = {
  text: '',
  source: undefined,
  runner: null,
  agentProfile: null,
  model: null,
  variants: 1,
  runMode: 'start',
  reviewSameModel: null,
  reviewCrossModel: null,
  worktree: null,
  autonomous: null,
  generateFollowups: null,
  dispatch: null,
} as const

const shot = (name = 'pasted image'): PendingAttachment => ({
  mediaType: 'image/png',
  data: 'iVBORw0KGgo=',
  preview: 'data:image/png;base64,iVBORw0KGgo=',
  name,
  isImage: true,
})

describe('resolveComposerRunMode', () => {
  const base = {
    hasGit: true,
    variants: 1,
    planFirst: false,
    explicitAutonomous: null,
    explicitWorktree: null,
    configuredAutonomous: 'source-dependent' as const,
    configuredWorktree: true,
    source: 'workflow' as const,
  }

  it('combines source fallback, configured policy, and explicit values', () => {
    expect(resolveComposerRunMode(base)).toEqual({ autonomous: false, worktree: true })
    expect(resolveComposerRunMode({ ...base, source: 'skill' })).toEqual({ autonomous: true, worktree: true })
    expect(resolveComposerRunMode({
      ...base,
      configuredAutonomous: true,
      configuredWorktree: false,
      explicitAutonomous: false,
      explicitWorktree: true,
    })).toEqual({ autonomous: false, worktree: true })
  })

  it('applies an interactive recommendation only to untouched fields', () => {
    expect(resolveComposerRunMode({ ...base, interactive: true })).toEqual({
      autonomous: false,
      worktree: false,
    })
    expect(resolveComposerRunMode({
      ...base,
      interactive: true,
      explicitAutonomous: true,
    })).toEqual({ autonomous: true, worktree: false })
  })

  it('keeps plan, parallel, and no-git constraints authoritative', () => {
    expect(resolveComposerRunMode({ ...base, planFirst: true, explicitAutonomous: true }).autonomous).toBe(false)
    expect(resolveComposerRunMode({ ...base, variants: 2, explicitWorktree: false }).worktree).toBe(true)
    expect(resolveComposerRunMode({ ...base, hasGit: false, explicitWorktree: true }).worktree).toBe(false)
  })

  it('keeps explicit and configured Worktree opt-outs authoritative for ordinary workflows', () => {
    expect(resolveComposerRunMode({ ...base, explicitWorktree: false }).worktree).toBe(false)
    expect(resolveComposerRunMode({ ...base, configuredWorktree: false }).worktree).toBe(false)
  })
})

describe('resolveComposerRunMode with dispatch (spec 2026-09-10-dispatch)', () => {
  const base = {
    hasGit: true,
    variants: 1,
    planFirst: false,
    explicitAutonomous: null,
    explicitWorktree: null,
    configuredAutonomous: 'source-dependent' as const,
    configuredWorktree: true,
    source: 'workflow' as const,
    dispatch: true,
  }

  it('forces the worktree on and defaults autonomous on', () => {
    expect(resolveComposerRunMode(base)).toEqual({ autonomous: true, worktree: true })
    // An explicit worktree opt-out and a workspace policy are both overruled — subtasks fork
    // off the parent's commits, which needs a tree of its own.
    expect(resolveComposerRunMode({ ...base, explicitWorktree: false, configuredWorktree: false }))
      .toEqual({ autonomous: true, worktree: true })
    // An interactive skill's recommendation is about the parent pausing for the user; a
    // dispatching parent keeps going while its children work.
    expect(resolveComposerRunMode({ ...base, interactive: true, source: 'skill' }).autonomous).toBe(true)
  })

  it('yields to an explicit Autonomous off, to plan-first, and to a missing repo', () => {
    expect(resolveComposerRunMode({ ...base, explicitAutonomous: false }))
      .toEqual({ autonomous: false, worktree: true })
    expect(resolveComposerRunMode({ ...base, planFirst: true }).autonomous).toBe(false)
    expect(resolveComposerRunMode({ ...base, hasGit: false }).worktree).toBe(false)
  })
})

describe('the new-task draft store', () => {
  it('starts empty with the never-chosen sentinels', () => {
    expect(readDraft()).toEqual({
      text: '',
      // undefined, not null (2026-08-15): untouched must stay distinguishable from an explicit
      // None pick — see the NewTaskDraft.source doc comment.
      source: undefined,
      runner: null,
      agentProfile: null,
      model: null,
      variants: 1,
      runMode: 'start',
      worktree: null,
      autonomous: null,
      generateFollowups: null,
      reviewSameModel: null,
      reviewCrossModel: null, dispatch: null,
    })
  })

  it('round-trips a draft and hands out copies, not the stored object', () => {
    writeDraft({
      text: 'fix it',
      source: { source: 'skill', ref: 'om-fix' },
      runner: 'codex',
      agentProfile: null,
      model: 'gpt-5-codex',
      variants: 2,
      runMode: 'start',
      worktree: false,
      autonomous: null,
      generateFollowups: false,
      reviewSameModel: null,
      reviewCrossModel: null, dispatch: null,
    })
    const first = readDraft()
    expect(first.text).toBe('fix it')
    expect(first.worktree).toBe(false)
    expect(first.generateFollowups).toBe(false)
    first.text = 'mutated'
    expect(readDraft().text).toBe('fix it')
  })

  it('clearStartedDraft spends the text AND the source, keeping the way-of-working pills', () => {
    writeDraft({
      text: 'shipped',
      source: { source: 'skill', ref: 'om-fix' },
      runner: null,
      agentProfile: null,
      model: 'opus',
      variants: 3,
      runMode: 'plan',
      worktree: null,
      autonomous: null,
      generateFollowups: true,
      reviewSameModel: null,
      reviewCrossModel: null, dispatch: null,
    })
    clearStartedDraft()
    expect(readDraft()).toEqual({
      text: '',
      // The skill goes with the task it ran: the next `/new` starts with none.
      source: null,
      runner: null,
      agentProfile: null,
      // Runner/model/variants/plan-first are a way of working — they survive, as they always did.
      model: 'opus',
      variants: 3,
      runMode: 'plan',
      worktree: null,
      autonomous: null,
      generateFollowups: true,
      reviewSameModel: null,
      reviewCrossModel: null, dispatch: null,
    })
  })

  it('survives a page reload — a cold read re-hydrates from localStorage', () => {
    writeDraft({
      text: 'do not lose me',
      source: { source: 'skill', ref: 'om-fix' },
      runner: 'claude',
      agentProfile: null,
      model: 'sonnet',
      variants: 2,
      runMode: 'plan',
      worktree: false,
      autonomous: null,
      generateFollowups: false,
      reviewSameModel: null,
      reviewCrossModel: null, dispatch: null,
    })
    // A fresh page has no in-memory cache but keeps localStorage: resetDraft removes storage, so
    // instead drop only the cache by round-tripping through a raw storage read.
    const raw = localStorage.getItem('cez-new-task-draft') as string
    expect(JSON.parse(raw)).toMatchObject({
      text: 'do not lose me',
      variants: 2,
      worktree: false,
      autonomous: null,
      generateFollowups: false,
      runMode: 'plan',
    })
  })

  it('an explicit None pick (source: null) round-trips distinctly from untouched (undefined)', () => {
    writeDraft({
      text: 'no workflow please',
      source: null,
      runner: null,
      agentProfile: null,
      model: null,
      variants: 1,
      runMode: 'start',
      worktree: null,
      autonomous: null,
      generateFollowups: null,
      reviewSameModel: null,
      reviewCrossModel: null, dispatch: null,
    })
    expect(readDraft().source).toBeNull()

    // Cold read (no in-memory cache) must also come back explicitly null, not coerced to
    // undefined — JSON round-trips `null` faithfully; that is exactly what normalize() must keep.
    const raw = localStorage.getItem('cez-new-task-draft') as string
    expect(JSON.parse(raw).source).toBeNull()
    resetDraft()
    localStorage.setItem('cez-new-task-draft', raw)
    expect(readDraft().source).toBeNull()
  })

  it('migrates legacy planFirst drafts and preserves a fresh backlog choice', () => {
    resetDraft()
    localStorage.setItem('cez-new-task-draft', JSON.stringify({ text: 'legacy', planFirst: true, v: 2 }))
    expect(readDraft().runMode).toBe('plan')

    resetDraft()
    localStorage.setItem('cez-new-task-draft', JSON.stringify({ text: 'legacy', planFirst: false, v: 2 }))
    expect(readDraft().runMode).toBe('start')

    resetDraft()
    localStorage.setItem('cez-new-task-draft', JSON.stringify({ text: 'legacy', v: 2 }))
    expect(readDraft().runMode).toBe('start')

    resetDraft()
    localStorage.setItem('cez-new-task-draft', JSON.stringify({ text: 'file me', runMode: 'backlog', v: 2 }))
    expect(readDraft().runMode).toBe('backlog')
  })

  /**
   * The DRAFT_VERSION migration (2026-08-15, owner: "no workflow should be selected by
   * default"). A draft written before the None default could hold a `source` that was never an
   * explicit pick — the composer used to preselect `quick-task` and persist it — so an
   * unversioned stored draft must come back with no source at all, while keeping everything the
   * user actually typed and chose. Without this, every machine that had ever used the old
   * composer would keep showing a preselected workflow no matter how correct the new code is.
   */
  describe('the pre-versioning migration', () => {
    const LEGACY = JSON.stringify({
      text: 'half a task',
      source: { source: 'workflow', ref: 'quick-task' },
      runner: 'codex',
      agentProfile: 'work',
      model: 'opus',
      variants: 2,
      planFirst: true,
      worktree: false,
      autonomous: true,
      generateFollowups: false,
    })

    it('drops a source stored without a version marker, and keeps everything else', () => {
      resetDraft()
      localStorage.setItem('cez-new-task-draft', LEGACY)
      const draft = readDraft()
      expect(draft.source).toBeUndefined()
      // Not a blanket wipe: the text and every run setting are the user's and survive intact.
      expect(draft).toMatchObject({
        text: 'half a task',
        runner: 'codex',
        agentProfile: 'work',
        model: 'opus',
        variants: 2,
        runMode: 'plan',
        worktree: false,
        autonomous: true,
        generateFollowups: false,
      })
    })

    it('keeps a source once the draft has been written by this version', () => {
      // The negative control for the test above: the drop must be keyed on the MISSING marker,
      // not on "source is always dropped" — otherwise a real pick could never persist at all.
      resetDraft()
      writeDraft({
        text: 'half a task',
        source: { source: 'workflow', ref: 'quick-task' },
        runner: null, agentProfile: null, model: null, variants: 1,
        runMode: 'start', worktree: null, autonomous: null, generateFollowups: null,
        reviewSameModel: null, reviewCrossModel: null, dispatch: null,
      })
      const stored = localStorage.getItem('cez-new-task-draft') as string
      resetDraft()
      localStorage.setItem('cez-new-task-draft', stored)
      expect(readDraft().source).toEqual({ source: 'workflow', ref: 'quick-task' })
    })

    it('does not resurrect a source when the marker is a DIFFERENT version', () => {
      resetDraft()
      localStorage.setItem(
        'cez-new-task-draft',
        JSON.stringify({ ...JSON.parse(LEGACY), v: 1 }),
      )
      expect(readDraft().source).toBeUndefined()
    })
  })

  it('normalizes a malformed/older stored value instead of throwing', () => {
    // A cold read (cache null after resetDraft) hitting bad JSON must degrade to EMPTY.
    resetDraft()
    localStorage.setItem('cez-new-task-draft', 'not json at all')
    expect(readDraft()).toEqual({
      text: '',
      source: undefined,
      runner: null,
      agentProfile: null,
      model: null,
      variants: 1,
      runMode: 'start',
      worktree: null,
      autonomous: null,
      generateFollowups: null,
      reviewSameModel: null,
      reviewCrossModel: null, dispatch: null,
    })

    resetDraft()
    localStorage.setItem('cez-new-task-draft', '{"text":42,"variants":9,"source":"nope","worktree":"x"}')
    expect(readDraft()).toEqual({
      text: '',
      // A malformed "nope" string is neither a valid source nor an explicit null — untouched.
      source: undefined,
      runner: null,
      agentProfile: null,
      model: null,
      variants: 1,
      runMode: 'start',
      worktree: null,
      autonomous: null,
      generateFollowups: null,
      reviewSameModel: null,
      reviewCrossModel: null, dispatch: null,
    })
  })
})

/**
 * #1018 — switching project while composing takes the composition with you.
 *
 * The per-project keys are right, and stay: a half-typed task for the shop frontend must not
 * surface in the cezar composer. What they were wrong ABOUT is the explicit switch — the user
 * changing their mind mid-sentence about where this task belongs, with a screenshot already
 * pasted. That is a move, and the rules below are what keep it one.
 */
describe('the new-task attachment store', () => {
  it('keeps attachments per project and hands out copies, not the stored array', () => {
    writeAttachments([shot('a.png')], null)
    writeAttachments([shot('b.png'), shot('c.png')], 'shop')

    expect(readAttachments(null).map((a) => a.name)).toEqual(['a.png'])
    expect(readAttachments('shop').map((a) => a.name)).toEqual(['b.png', 'c.png'])
    // A project nobody has touched has nothing attached.
    expect(readAttachments('blog')).toEqual([])

    const held = readAttachments('shop')
    held.pop()
    expect(readAttachments('shop')).toHaveLength(2)
  })

  it('never reaches localStorage — four 5 MB images would not fit', () => {
    writeAttachments([shot()], 'shop')
    expect(
      Object.keys(localStorage).filter((key) => key.startsWith('cez-new-task-draft')),
    ).toEqual([])
  })
})

describe('handOffComposition', () => {
  it('moves the text and the attachments to the arriving project', () => {
    writeDraft({ ...EMPTY_DRAFT, text: 'fix the flake', runner: 'codex' }, null)
    writeAttachments([shot('screenshot.png')], null)

    expect(handOffComposition(null, 'shop')).toEqual({ moved: true })

    expect(readDraft('shop').text).toBe('fix the flake')
    expect(readAttachments('shop').map((a) => a.name)).toEqual(['screenshot.png'])
    // A MOVE: the composition now exists in exactly one project, which is what keeps the
    // per-project isolation the storage keys are for actually true.
    expect(readDraft(null).text).toBe('')
    expect(readAttachments(null)).toEqual([])
  })

  it('leaves the pickers behind — a skill ref is resolved against a project’s own catalog', () => {
    writeDraft(
      { ...EMPTY_DRAFT, text: 'ship it', source: { source: 'skill', ref: 'om-fix' }, model: 'opus' },
      null,
    )

    handOffComposition(null, 'shop')

    expect(readDraft('shop').source).toBeUndefined()
    expect(readDraft('shop').model).toBeNull()
    // …and the departing project keeps its own way of working, minus the spent text.
    expect(readDraft(null).source).toEqual({ source: 'skill', ref: 'om-fix' })
  })

  it('refuses to clobber an unsent draft already waiting in the arriving project', () => {
    writeDraft({ ...EMPTY_DRAFT, text: 'from cezar' }, null)
    writeAttachments([shot('cezar.png')], null)
    writeDraft({ ...EMPTY_DRAFT, text: 'already writing this' }, 'shop')

    expect(handOffComposition(null, 'shop')).toEqual({ moved: false, reason: 'destination-busy' })

    // Nothing lost on either side: the arriving project's work in progress wins, and the
    // departing one still holds what was typed there — switching back restores it.
    expect(readDraft('shop').text).toBe('already writing this')
    expect(readAttachments('shop')).toEqual([])
    expect(readDraft(null).text).toBe('from cezar')
    expect(readAttachments(null).map((a) => a.name)).toEqual(['cezar.png'])
  })

  it('carries an attachment pasted before a word was typed', () => {
    writeAttachments([shot()], null)

    expect(handOffComposition(null, 'shop')).toEqual({ moved: true })
    expect(readAttachments('shop')).toHaveLength(1)
    expect(readAttachments(null)).toEqual([])
  })

  it('does nothing when there is nothing to move, or nowhere to move it', () => {
    expect(handOffComposition(null, 'shop')).toEqual({ moved: false, reason: 'nothing-to-move' })

    writeDraft({ ...EMPTY_DRAFT, text: 'typed' }, 'shop')
    expect(handOffComposition('shop', 'shop')).toEqual({ moved: false, reason: 'same-project' })
    expect(readDraft('shop').text).toBe('typed')
  })
})

describe('normalizeDispatchIntent', () => {
  it('keeps only the contract keys, within the contract ranges', () => {
    expect(normalizeDispatchIntent({
      maxSubtasks: 10, inFlight: 9, runner: 'nope', model: '', budgetUsd: -1, extra: 1,
    })).toEqual({ maxSubtasks: 10 })
    expect(normalizeDispatchIntent({
      maxSubtasks: 51, inFlight: 2, runner: 'codex', model: 'gpt-future', budgetUsd: 2.5,
    })).toEqual({ inFlight: 2, runner: 'codex', model: 'gpt-future', budgetUsd: 2.5 })
    expect(normalizeDispatchIntent({ maxSubtasks: 1.5, budgetUsd: 10_001 })).toEqual({})
  })

  it('answers null for anything but a plain object — the toggle is off', () => {
    for (const raw of [null, undefined, 'on', true, 1, [], [1]]) {
      expect(normalizeDispatchIntent(raw)).toBeNull()
    }
    // The bare toggle: on, engine defaults.
    expect(normalizeDispatchIntent({})).toEqual({})
  })

  it('round-trips through the store', () => {
    writeDraft({ ...readDraft(), dispatch: { maxSubtasks: 10, inFlight: 2 } })
    resetDraftCacheOnly()
    expect(readDraft().dispatch).toEqual({ maxSubtasks: 10, inFlight: 2 })
    localStorage.setItem('cez-new-task-draft', '{"dispatch":"yes please"}')
    resetDraftCacheOnly()
    expect(readDraft().dispatch).toBeNull()
  })
})

/** Drop the in-memory cache but keep localStorage — a reload, not a reset. */
function resetDraftCacheOnly() {
  const stored = localStorage.getItem('cez-new-task-draft')
  resetDraft()
  if (stored !== null) localStorage.setItem('cez-new-task-draft', stored)
}

describe('composerRunModeNote (#793)', () => {
  // One line per place the run can land. The header used to print the first one unconditionally,
  // so the other two states read as an outright false promise of isolation.
  const cases: Array<{ worktree: boolean; hasGit: boolean; expected: string }> = [
    {
      worktree: true,
      hasGit: true,
      expected: 'Runs in an isolated worktree — review everything before it lands.',
    },
    {
      worktree: false,
      hasGit: true,
      expected: 'Runs in the repo working tree — your checkout is modified directly.',
    },
    {
      worktree: false,
      hasGit: false,
      expected: 'Runs in place — no git repository detected, so there is no worktree to isolate in.',
    },
  ]

  for (const { worktree, hasGit, expected } of cases) {
    it(`worktree=${worktree}, hasGit=${hasGit}`, () => {
      expect(composerRunModeNote({ worktree, hasGit })).toBe(expected)
    })
  }

  it('names the fan-out when dispatch is on, in both autonomy states', () => {
    expect(composerRunModeNote({ worktree: true, hasGit: true, dispatch: true, autonomous: true }))
      .toBe('Runs on its own and fans work out to subtasks — it will not pause for you.')
    expect(composerRunModeNote({ worktree: true, hasGit: true, dispatch: true, autonomous: false }))
      .toBe('Fans work out to subtasks in isolated worktrees.')
    // Off, the existing three states are untouched.
    expect(composerRunModeNote({ worktree: true, hasGit: true, dispatch: false }))
      .toBe('Runs in an isolated worktree — review everything before it lands.')
  })

  it('never promises isolation without a worktree', () => {
    // The invariant the header actually owes the user, independent of the exact copy: the word
    // only appears when the run really gets one.
    for (const hasGit of [true, false]) {
      expect(composerRunModeNote({ worktree: false, hasGit })).not.toContain('isolated worktree')
    }
  })

  // Workspace (cross-project-workspace-run.md) is a fourth state that wins over the other three.
  // CORRECTED 2026-08-25 (`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`): the expected
  // string was ~~"your real checkouts are modified directly, with no worktree"~~, which described
  // a run that edited every project's live tree. It no longer does one, so holding the header to
  // that sentence would hold it to a false one.
  it('workspace wins over worktree/hasGit, and never promises isolation', () => {
    for (const worktree of [true, false]) {
      for (const hasGit of [true, false]) {
        const note = composerRunModeNote({ worktree, hasGit, workspace: true })
        expect(note).toBe(
          'Reads every project and files tasks on their boards — it edits no project file, and starts nothing.',
        )
        expect(note).not.toContain('isolated')
      }
    }
  })

  it('autoStart drops the "starts nothing" half, and only that half', () => {
    // The two workspace lines are one control's two states. A header still saying "starts nothing"
    // above a ticked Start-filed-tasks chip is the same class of lie as the sentence corrected
    // above — and one that only shows up when the user opts INTO the more consequential path.
    const off = composerRunModeNote({ worktree: true, hasGit: true, workspace: true })
    const on = composerRunModeNote({ worktree: true, hasGit: true, workspace: true, autoStart: true })
    expect(off).toContain('starts nothing')
    expect(on).not.toContain('starts nothing')
    // Both still say where the work is filed — autoStart changes what happens next, not where.
    for (const note of [off, on]) expect(note).toContain('files tasks on their boards')
  })

  it('autoStart on a NON-workspace note changes nothing', () => {
    // The chip only renders at workspace scope; this pins that the parameter cannot leak into the
    // other three states if a future caller passes it unconditionally.
    for (const worktree of [true, false]) {
      expect(composerRunModeNote({ worktree, hasGit: true, autoStart: true })).toBe(
        composerRunModeNote({ worktree, hasGit: true }),
      )
    }
  })

  it('workspace: false behaves exactly like omitting it', () => {
    expect(composerRunModeNote({ worktree: true, hasGit: true, workspace: false })).toBe(
      composerRunModeNote({ worktree: true, hasGit: true }),
    )
  })
})


describe('clearDraftText keeps explicit project picker choices', () => {
  it('spends the prompt while retaining a chosen source', () => {
    writeDraft({ ...readDraft(), text: 'Done', source: { source: 'workflow', ref: 'input-to-tasks' } })
    clearDraftText()
    expect(readDraft().text).toBe('')
    expect(readDraft().source).toEqual({ source: 'workflow', ref: 'input-to-tasks' })
  })
})
