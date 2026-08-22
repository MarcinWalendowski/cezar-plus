// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * A shipped module that imports `Tooltip` must import `TooltipProvider` alongside it.
 *
 * Why a static scan and not a render test: a bare Radix `Tooltip` does not degrade when no
 * provider is mounted above it — it THROWS, so the failure is a white screen of whatever route
 * happened to render it. On 2026-08-22 `AuthorCell` shipped depending on an ancestor provider that
 * the two task tables happened to have and the run header did not, and every task carrying an
 * author crashed its thread page in production
 * (``Uncaught Error: `Tooltip` must be used within `TooltipProvider` ``). See
 * `.ai/specs/2026-08-21-task-author-provenance.md` § the 2026-08-22 correction.
 *
 * What this can and cannot prove. It cannot prove a given `<Tooltip>` is *wrapped* — a file may
 * import both and still leave one usage outside the provider it mounts. What it does catch is the
 * mistake that actually happened and is the cheap one to make: a component reaching for `Tooltip`
 * alone and inheriting a provider from whoever renders it. That inheritance is a per-surface
 * coincidence, not a contract, and the next call site is where it breaks. A file that legitimately
 * relies on a provider it opens elsewhere in the SAME file still imports the provider, so the rule
 * costs those files nothing.
 *
 * `radix-ui`'s Tooltip is the only primitive in `components/ui/` that requires a provider, so this
 * rule is deliberately about that one import and not a general context lint.
 */

const UI_DIR = path.dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = path.resolve(UI_DIR, '../..')
/** The module that DEFINES the primitives — it names them without importing them. */
const DEFINITION_SITE = path.join(UI_DIR, 'tooltip.tsx')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__fixtures__') continue
      out.push(...sourceFiles(full))
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** The named bindings of every `… from '@/components/ui/tooltip'` import in a file. */
function tooltipImports(source: string): string[] {
  const named: string[] = []
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]@\/components\/ui\/tooltip['"]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    // `noUncheckedIndexedAccess` is on: an indexed read is `T | undefined` even when the regex
    // guarantees the group. Default rather than assert — a `!` here would be the same "trust me"
    // this file exists to catch.
    for (const raw of (match[1] ?? '').split(',')) {
      const name = (raw.trim().split(/\s+as\s+/)[0] ?? '').trim()
      if (name) named.push(name)
    }
  }
  return named
}

describe('Tooltip cannot be imported without TooltipProvider', () => {
  const files = sourceFiles(SRC_ROOT).filter((f) => f !== DEFINITION_SITE)
  const consumers = files
    .map((file) => ({ file, named: tooltipImports(readFileSync(file, 'utf8')) }))
    .filter((entry) => entry.named.includes('Tooltip'))

  it('found the Tooltip consumers it is meant to be checking', () => {
    // Floor assertion — the positive control on the scan itself. Without it, a renamed alias or a
    // moved directory turns this suite green by finding nothing, which reads exactly like a pass.
    expect(consumers.length).toBeGreaterThanOrEqual(5)
    expect(consumers.map((c) => path.basename(c.file)).sort()).toContain('author-cell.tsx')
  })

  it('every one of them imports TooltipProvider too', () => {
    const offenders = consumers
      .filter((entry) => !entry.named.includes('TooltipProvider'))
      .map((entry) => path.relative(SRC_ROOT, entry.file))
    expect(offenders).toEqual([])
  })
})
