import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const appDir = dirname(fileURLToPath(import.meta.url))
const packagesDir = resolve(appDir, '..')

// The cockpit server (packages/cezar/src/server/server.ts) owns /api and serves the built app.
// `npm run dev` (scripts/dev.mjs) picks a free port and pins both processes to it via
// CEZ_API_PORT, so a stray cockpit already sitting on 4321 (another repo, an older install)
// can never end up behind the proxy. Standalone `npm run dev:web` keeps the 4321 default.
const API_TARGET = `http://127.0.0.1:${process.env.CEZ_API_PORT ?? 4321}`

// React DOM is large enough to push the otherwise route-split entry chunk over Vite's 500 kB
// warning threshold. Keep the tightly coupled React runtime in one stable, cacheable chunk
// rather than silencing the warning: future growth in either the app or vendor chunk stays
// visible. Module ids from Vite/Rolldown use forward slashes on every platform.
export const reactRuntimeChunk = {
  name: 'react-runtime',
  test: /node_modules\/(?:react(?:-dom)?|scheduler)\//,
}

export default defineConfig({
  root: appDir,
  base: '/',
  // Tailwind v4 is CSS-first: the whole theme lives in src/styles/index.css, there is no tailwind.config.js.
  plugins: [react(), tailwindcss()],
  // `@/…` → packages/web/src — the alias shadcn/ui components import `cn` through. Mirrored in
  // tsconfig.json `paths`.
  //
  // The api-client resolves to its SOURCE, not to its published `dist`. The package builds
  // (for Node consumers and for npm) but nothing in the web toolchain should have to wait for
  // that build: aliasing to source keeps `npm run dev` a single step and gives HMR when the
  // contract changes. Vite maps the package's internal `./x.ts` specifiers directly. Mirrored
  // in tsconfig.json `paths`.
  resolve: {
    alias: {
      '@': resolve(appDir, 'src'),
      '@loki-labs/cezar-plus-api-client': resolve(packagesDir, 'api-client/src/index.ts'),
    },
  },
  build: {
    // Built INTO the server package, because the CLI ships and serves it: `resolveWebDir()`
    // looks for `<pkg>/web/dist` next to its own `dist/`, and `files` puts it in the tarball.
    // A cross-package output is the honest expression of that coupling — the cockpit bundle is
    // an artifact of the service, not a separately shipped thing.
    outDir: resolve(packagesDir, 'cezar/web/dist'),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [reactRuntimeChunk],
        },
      },
    },
  },
  server: {
    proxy: {
      // `ws: true` — /api/ws (the subscription socket) upgrades through the same proxy.
      '/api': { target: API_TARGET, changeOrigin: true, ws: true },
      // `/auth/*` is a ROOT-mounted family (`src/index.ts`, D13/D14), not under `/api`, so it
      // needs its own entry: `onboarding-api.ts`/`teams-api.ts`/`account-api.ts` all fetch
      // `${getApiBaseUrl()}/auth/...`, which in dev is same-origin on the Vite port. Without
      // this the request fell through to Vite's SPA fallback and came back as `200 text/html`,
      // which `isJsonResponse()` reads — correctly, for what it saw — as "no onboarding surface
      // on this deployment": the org wizard and the Teams pane both rendered "Sign-in isn't set
      // up on this deployment" in `npm run dev` while the server was answering real
      // `needs-org` JSON on 4321 the whole time. Dev-only; the built cockpit is served by the
      // same origin as the routes, so production never had the gap.
      '/auth': { target: API_TARGET, changeOrigin: true },
    },
  },
})
