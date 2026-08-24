import { defineConfig } from 'vitest/config'

import { halfParallelism, positiveIntEnvOr } from '../cezar/src/core/search-parallelism.ts'

// `packages/contract` had test FILES but no project, so `npm test` never ran them:
// `agent-route.test.ts` had been sitting green-by-absence, and the first test written against
// `usage-hold.ts` would have been too (spec `2026-08-23-usage-limit-hold-account.md`). A test that
// cannot run is worse than no test, because the file's existence reads as coverage.
//
// `maxWorkers` is derived exactly as every other project derives it — see the long note in
// `packages/api-client/vitest.config.ts`: vitest 4 refuses a mixed cap, and a project that
// disagreed would either fail planning or quietly opt out of the whole-box budget.
const maxWorkers = positiveIntEnvOr(process.env.CEZ_VITEST_MAX_WORKERS, () => halfParallelism())

// Node environment, and the package's own rule is stronger than a preference: nothing in the
// contract may reach for a DOM or for `node:*`, so a jsdom here would hide exactly the
// browser-only dependency this package exists to keep out.
export default defineConfig({
  test: {
    name: 'contract',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    maxWorkers,
  },
})
