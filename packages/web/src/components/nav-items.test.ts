import { describe, expect, it } from 'vitest'

import { NAV_ITEMS, activeNavItem, activeNavPath, visibleNavItems } from './nav-items'

/** Which nav item owns a URL. This is the rule that decides what the user sees lit up, and it
 *  is not a plain equality check — items own areas, and the Settings area nests. */
describe('activeNavPath', () => {
  const cases: Array<[pathname: string, active: string | null]> = [
    // Tasks owns the overview *and* every task surface (spec: "clicking a row opens
    // /tasks/:id with Tasks still active").
    ['/', '/'],
    ['/tasks/abc123', '/'],
    ['/tasks/abc123/changes', '/'],
    ['/tasks/abc123/files', '/'],
    ['/compare/grp-1', '/'],

    ['/inbox', '/inbox'],
    ['/git', '/git'],
    ['/knowledge', '/knowledge'],
    ['/knowledge/abc123', '/knowledge'],
    ['/skills', '/skills'],

    // Hidden 2026-08-14 (owner decision, `NAV_ITEMS`): the ROUTES still render, so these URLs
    // are reachable by hand — they just have no nav item to light up any more, which is the same
    // `null` every off-nav surface answers. Kept as cases rather than deleted because that is the
    // observable consequence of the hide, and a restored item must flip them back. (Skills was
    // restored 2026-08-17 — it lights `/skills` above; GitHub and Workflows stay hidden.)
    ['/github', null],
    ['/github/issues/42', null],
    ['/github/prs/7', null],
    ['/workflows', null],
    ['/workflows/ship-it', null],

    // The nested Settings area: deeper routes fall to the Settings item.
    ['/settings', '/settings'],
    ['/settings/appearance', '/settings'],
    ['/settings/agents', '/settings'],

    // Full-screen surfaces with no nav home — nothing may light up.
    ['/new', null],
    ['/nope-404', null],
  ]

  for (const [pathname, active] of cases) {
    it(`${pathname} → ${active ?? 'no active item'}`, () => {
      expect(activeNavPath(pathname)).toBe(active)
    })
  }

  // A `startsWith` implementation passes every case above and still fails these two. The first
  // still earns its keep with GitHub hidden — a prefix match would make `/git` OWN `/github`,
  // lighting the Git tab on a page that is not it, which is a louder wrong answer than `null`.
  it('does not let /git claim the /github area', () => {
    expect(activeNavPath('/github')).toBeNull()
  })

  it('does not let the root item claim every route', () => {
    expect(activeNavPath('/git')).toBe('/git')
  })
})

describe('activeNavItem', () => {
  it('returns the item, so the mobile bar can title itself', () => {
    expect(activeNavItem('/tasks/abc123')?.label).toBe('Tasks')
    expect(activeNavItem('/knowledge/abc123')?.label).toBe('Knowledge')
    expect(activeNavItem('/skills')?.label).toBe('Skills')
  })

  it('returns null off-nav', () => {
    expect(activeNavItem('/new')).toBeNull()
  })

  /** The hidden routes (2026-08-14) reach the same answer as `/new`: they render, and the mobile
   *  bar titles itself from the route rather than from a nav item that no longer exists. (Skills
   *  was restored 2026-08-17, so it is no longer among them — GitHub and Workflows stay hidden.) */
  it('returns null for a hidden surface', () => {
    expect(activeNavItem('/workflows')).toBeNull()
    expect(activeNavItem('/github')).toBeNull()
  })
})

describe('NAV_ITEMS', () => {
  it('is the nav from the spec, in mockup order', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'Automations',
      'Knowledge',
      'Skills',
      'Notes',
      'Settings',
    ])
  })

  /** The hide is a property of THIS list and nothing else (owner decision, 2026-08-14): no gate,
   *  no capability, no flag — so the only thing that can bring an item back is editing the array.
   *  Asserted by name because the label list above would also pass if a rename, rather than the
   *  hide, had removed them. (Skills was restored 2026-08-17 — it IS in the list now, gated by
   *  `skills`; GitHub and Workflows stay hidden.) */
  it('carries no GitHub or Workflows item', () => {
    const labels = NAV_ITEMS.map((item) => item.label)
    const paths = NAV_ITEMS.map((item) => item.to)
    for (const hidden of ['GitHub', 'Workflows']) expect(labels).not.toContain(hidden)
    for (const hidden of ['/github', '/workflows']) expect(paths).not.toContain(hidden)
    // …and no item's `match` reaches them either, which is what `activeNavPath` reads.
    expect(NAV_ITEMS.flatMap((item) => item.match)).not.toContain('/github')
  })

  // Every item must be reachable by its own URL, or a click would navigate somewhere that
  // does not light the item the user just clicked.
  it('each item is the active item for its own `to`', () => {
    for (const item of NAV_ITEMS) {
      expect(activeNavPath(item.to)).toBe(item.to)
    }
  })
})

/** The gates: the GitHub item exists exactly while health reports the forge driver (R6 Step 1.1),
 *  the Inbox item exactly while it reports the opt-in `capabilities.followups` (#471), the
 *  Knowledge item exactly while it reports `capabilities.knowledge` (central-hub F1), and the
 *  Automations item exactly while it reports a forge AND the opt-in `capabilities.automations`
 *  (#801). Each gate owns ONLY its own item, and all default to absent while health is unknown. */
describe('visibleNavItems', () => {
  const ALL: Required<Parameters<typeof visibleNavItems>[0]> = {
    forge: true,
    inbox: true,
    knowledge: true,
    skills: true,
    automations: true,
    notes: true,
  }
  const labelsOf = (opts?: Parameters<typeof visibleNavItems>[0]) =>
    visibleNavItems(opts).map((item) => item.label)

  it('with everything available, the full nav renders', () => {
    expect(visibleNavItems(ALL)).toEqual(NAV_ITEMS)
  })

  it('without a forge, the Automations item drops out', () => {
    expect(labelsOf({ ...ALL, forge: false })).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'Knowledge',
      'Skills',
      'Notes',
      'Settings',
    ])
  })

  it('without the inbox, exactly the Inbox item drops out (#471)', () => {
    expect(labelsOf({ ...ALL, inbox: false })).toEqual([
      'Tasks',
      'Git',
      'Automations',
      'Knowledge',
      'Skills',
      'Notes',
      'Settings',
    ])
  })

  it('without knowledge, exactly the Knowledge item drops out (central-hub F1)', () => {
    expect(labelsOf({ ...ALL, knowledge: false })).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'Automations',
      'Skills',
      'Notes',
      'Settings',
    ])
  })

  /** The notes gate owns only its own item, and — the half worth pinning — the Notes item is the
   *  one that must NOT appear by default. `CEZ_NOTES` unset is the shipped state for every install
   *  that never opted in, and a capture inbox in the sidebar of an install with no note store
   *  behind it is exactly the "promises a feature" failure the 2026-08-14 removal was about. */
  it('without the notes opt-in, exactly the Notes item drops out', () => {
    expect(labelsOf({ ...ALL, notes: false })).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'Automations',
      'Knowledge',
      'Skills',
      'Settings',
    ])
  })

  it('omitting availability entirely hides Notes — absent is not on', () => {
    expect(labelsOf()).not.toContain('Notes')
  })

  it('without the automations opt-in, exactly the Automations item drops out (#801)', () => {
    expect(labelsOf({ forge: true, inbox: true, automations: false })).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'Skills',
      'Settings',
    ])
  })

  it('drops everything gated when nothing is available', () => {
    expect(
      labelsOf({ forge: false, inbox: false, knowledge: false, automations: false }),
    ).toEqual(['Tasks', 'Git', 'Skills', 'Settings'])
  })

  /** The `skills` gate owns the Skills item again (restored 2026-08-17, see `NavItem.skills`):
   *  it is the lone opt-OUT here, so `CEZ_SKILLS=0` → `skills: false` from health → exactly the
   *  Skills item drops, and nothing else. */
  it('without the skills opt-out, exactly the Skills item drops (CEZ_SKILLS=0)', () => {
    expect(labelsOf({ ...ALL, skills: false })).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'Automations',
      'Knowledge',
      'Notes',
      'Settings',
    ])
  })

  // The two gates on that one item are ANDed: a forge alone does not resurrect it, which is the
  // whole point of #801 — every project with a GitHub remote used to see the tab.
  it('a forge alone does not bring Automations back', () => {
    expect(labelsOf({ forge: true, inbox: false })).not.toContain('Automations')
  })

  it('drops all three when nothing is available', () => {
    expect(labelsOf({ forge: false, inbox: false, automations: false })).toEqual([
      'Tasks',
      'Git',
      'Skills',
      'Settings',
    ])
  })

  it('defaults to absent — the nav claims nothing before health answers', () => {
    expect(labelsOf()).toEqual(
      labelsOf({ forge: false, inbox: false, knowledge: false, automations: false }),
    )
  })

  it('never invents an item — the result is always a subset of NAV_ITEMS, in order', () => {
    for (const forge of [true, false]) {
      for (const inbox of [true, false]) {
        for (const knowledge of [true, false]) {
          for (const automations of [true, false]) {
            const items = visibleNavItems({ forge, inbox, knowledge, automations })
            expect(NAV_ITEMS.filter((i) => items.includes(i))).toEqual(items)
          }
        }
      }
    }
  })
})
