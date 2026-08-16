import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import {
  ASSET_CACHE_CONTROL,
  BUILD_HINT_HTML,
  assetContentType,
  isSafeAssetFilename,
  resolveGetRequest,
} from './static-ui.ts';

/**
 * Serving the built React cockpit (`web/dist`) — the ONE implementation, used by both processes
 * that have to answer a browser.
 *
 * **ADDED 2026-08-07 at the phase 6/7 repair stage.** `createApp` (`./server.ts`) had this inline,
 * and `createSupervisorApp` (`../supervisor/server.ts`) had nothing — it mounted `authRoutes`,
 * `onboardingRoutes` and `/internal/*` and no static UI at all. Two consequences, both on day one
 * of any `--platform hetzner` deployment, and both reproduced by three independent reviews:
 *
 *  1. `auth/routes.ts`'s `/auth/callback` ends in `c.redirect('/onboarding', 302)`. On the login
 *     host that was a bare **404**, so D8's onboarding wizard was unreachable and no org could
 *     ever be created — not a second one, the FIRST one.
 *  2. `server-install/platforms/hetzner.ts#verifyStep` requires the login host to answer 2xx/3xx
 *     through nginx. It got 404, pushed a problem and threw `StepAborted`, so
 *     `server-install --platform hetzner --domain <login-host>` could never complete — after
 *     really creating the unix user, the unit, the vhost and the certificate. Phase 7's whole
 *     verification row is "provisions from clean".
 *
 * Extracted rather than duplicated because a second copy is the drift shape D3's own history in
 * this repo already names once (`server.ts`'s `LOCAL_PRINCIPAL` vs `auth/principal.ts`'s
 * `LOCAL_IDENTITY`, "hand-kept in sync … by convention, not by shared code"). The two apps now
 * serve byte-identical bytes from byte-identical paths, and a change to either can only be a
 * change to both.
 *
 * Pure module scope: nothing here reads a file, resolves a path or touches `web/dist` at import
 * time. Every read is per request (the existing `createApp` behaviour, deliberately — see
 * `serveCockpitShell`), so importing this module does no I/O, which is what lets `server.ts`
 * import it statically on the `CEZ_AUTH`-unset path without touching D1's "unset means zero I/O".
 */

/** `<pkg>/web` — this module lives at `<pkg>/{src,dist}/server/`, the same two levels down
 *  `server.ts` itself resolved from before this extraction, so the path is unchanged in both the
 *  built and the `tsx`-dev layouts. */
export function webDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
}

export function webDistDir(): string {
  return join(webDir(), 'dist');
}

const HTML_TYPE = 'text/html; charset=utf-8';

let hintLogged = false;

/**
 * The SPA shell for any GET the app itself does not own. `undefined` ⇒ `resolveGetRequest` says
 * this path is not the shell's to answer (`/api/*` and the static asset routes below), and the
 * caller falls through to its own 404 — an unknown API path must never answer with HTML.
 *
 * `existsSync` per request, like the reads below: `npm run build:web` in a running cockpit takes
 * effect on the next reload, no restart.
 */
export function serveCockpitShell(c: Context): Response | undefined {
  const distDir = webDistDir();
  const distIndex = join(distDir, 'index.html');
  const target = resolveGetRequest({ path: c.req.path, distExists: existsSync(distIndex) });
  if (target === 'passthrough') return undefined;
  if (target === 'build-hint') {
    // Dev-only state (the tarball ships web/dist): serve the built-in hint page instead of the
    // app — the legacy fallback UI was deleted in R7.
    if (!hintLogged) {
      hintLogged = true;
      console.log('cezar: web/dist is missing — run `npm run build:web` to build the cockpit');
    }
    return new Response(BUILD_HINT_HTML, { headers: { 'content-type': HTML_TYPE } });
  }
  return new Response(readFileSync(distIndex), { headers: { 'content-type': HTML_TYPE } });
}

/**
 * The built app's hashed bundles/fonts and the favicon `packages/web/index.html` points at.
 * Vite fingerprints every name, so the bytes behind a URL never change — cached hard.
 *
 * Only plain filenames are served: `basename('..')` is `'..'` (it resolves to the assets dir
 * itself and `readFileSync` would throw EISDIR), so dot-segments and separator-bearing params get
 * a 404, not a 500.
 */
export function cockpitAssetRoutes(): Hono {
  return new Hono()
    .get('/assets/:file', (c) => {
      const file = c.req.param('file');
      if (!isSafeAssetFilename(file)) return c.json({ error: 'not found' }, 404);
      const path = join(webDistDir(), 'assets', file);
      if (!existsSync(path) || !statSync(path).isFile()) return c.json({ error: 'not found' }, 404);
      return new Response(readFileSync(path), {
        headers: { 'content-type': assetContentType(file), 'cache-control': ASSET_CACHE_CONTROL },
      });
    })
    .get('/cezar.svg', (c) => {
      // Served out of the Vite build: the file is a `public/` asset of the web package, which the
      // build copies verbatim into `web/dist`. One home, one URL — the same bytes this route
      // hands out are what the bundle's own `<img src="/cezar.svg">` asks for. Without a
      // build there is nothing to serve, which is a 404 rather than a crash (the shell route
      // answers the same dev-only state with its build hint).
      const path = join(webDistDir(), 'cezar.svg');
      if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
      return new Response(readFileSync(path), { headers: { 'content-type': 'image/svg+xml' } });
    });
}
