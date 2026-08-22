import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

// Reuse the build config verbatim (root, React plugin, `@` → packages/web/src) and only add the
// test layer, so a component under test resolves its imports exactly like the shipped bundle.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      // NODE_ENV=production is standing in every cezar agent session (AGENTS.md trap 1) and forces
      // react/react-dom to require() their production builds, which export no `React.act` —
      // @testing-library/react's act-compat then throws "React.act is not a function" on every
      // test. Applied here (vitest's own `test.env`, resolved before any test module imports
      // anything) so the fix is immediate — no service redeploy, no dependency change — and reaches
      // a human running the gate directly, not only agent-spawned runs.
      env: { NODE_ENV: '' },
    },
  }),
)
