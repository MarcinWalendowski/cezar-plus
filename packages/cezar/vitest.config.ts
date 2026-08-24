import { defineConfig } from 'vitest/config'

import { halfParallelism, positiveIntEnvOr } from './src/core/search-parallelism.ts'

// The service + CLI suite: Node ESM, no DOM, no bundler. `test/` is deliberately NOT included
// — those are the node:test suites (`npm run test:unit`, `npm run test:package`), which pack
// and install the real tarball and must not run inside the fast unit gate.
//
// `maxWorkers` bounds the burst (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`,
// Phase 0 step 2; plan package 0.5) — see `src/core/search-parallelism.ts` for the derivation
// and why it is relative to the box's own core count rather than a constant. Override with
// `CEZ_VITEST_MAX_WORKERS` (a positive integer) for a machine that needs a different number
// without editing this file; read fresh on every `vitest` invocation.
const maxWorkers = positiveIntEnvOr(process.env.CEZ_VITEST_MAX_WORKERS, () => halfParallelism())

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Pins CEZ_HOME to a per-worker sandbox so no case can write the developer's
    // real ~/.cezar — see the file for the failure it prevents.
    setupFiles: ['./vitest.setup.ts'],
    maxWorkers,
  },
})
