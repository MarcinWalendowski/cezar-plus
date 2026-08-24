import { defineConfig } from 'vitest/config'

// Four packages, one `npm test`. Each owns its own vitest config — this file only names
// them, so `npm test -w <pkg>` and the whole-repo run execute the identical setup:
//   - packages/cezar      Node ESM (NodeNext, `.js` relative imports)
//   - packages/contract   the Node-free schema//key package both sides import
//   - packages/api-client the typed client over it
//   - packages/web        DOM code, resolved exactly as Vite bundles it
//
// `contract` was ADDED 2026-08-23: it had test files and no project, so `npm test` skipped them
// silently and `agent-route.test.ts` had never run. A file that looks like coverage and executes
// nothing is the failure mode this list exists to prevent.
export default defineConfig({
  test: {
    // The suites are still being grown; a project that currently matches no file must not
    // fail the validation gate. Root-level only — vitest rejects this inside a project.
    passWithNoTests: true,
    projects: [
      './packages/cezar/vitest.config.ts',
      './packages/contract/vitest.config.ts',
      './packages/api-client/vitest.config.ts',
      './packages/web/vitest.config.ts',
    ],
  },
})
