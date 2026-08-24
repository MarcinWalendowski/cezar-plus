import { defineConfig } from 'vitest/config'

import { halfParallelism, positiveIntEnvOr } from '../cezar/src/core/search-parallelism.ts'

// `maxWorkers` is set on EVERY project, from the one derivation in
// `packages/cezar/src/core/search-parallelism.ts` (spec
// `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, Phase 0 step 2 — "capping vitest workers and
// ripgrep threads at the source"). It has to be every project for two independent reasons:
//
//  1. **The cap is only real if it is uniform.** Bounding the burst means one `run-tests` step must
//     not claim the whole box. Capping `server` alone while `web` still forks one worker per test
//     file leaves the burst exactly as unbounded as before, since a whole-repo `npm test` runs them
//     together. Projects that agree on `maxWorkers` share ONE pool, so this budgets half the box to
//     the entire gate rather than half the box to each project.
//  2. **Vitest 4 refuses the mixed case.** Projects that differ in `maxWorkers` must carry distinct
//     `sequence.groupOrder`, and when only `server` had the field the whole-repo run died in
//     planning with ZERO tests executed. Distinct group orders would have satisfied the validator
//     while making the cap partial AND serialising the groups — slower, and still unbounded where
//     it matters. Agreeing is the fix; splitting is not.
//
// Importing a `packages/cezar` module from another package's config is deliberate: this file is
// build-time Node, never bundled, and a second copy of the derivation would drift the first time
// either side is retuned.

const maxWorkers = positiveIntEnvOr(process.env.CEZ_VITEST_MAX_WORKERS, () => halfParallelism())

// Node environment on purpose: nothing in the api-client may need a DOM to be tested, and a
// jsdom here would hide an accidental browser-only dependency in a package that the Node
// service imports too.
export default defineConfig({
  test: {
    name: 'api-client',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    maxWorkers,
  },
})
