import type { Env, Hono, Schema } from 'hono';

/**
 * `app.request()` with the `Host` header that every real client sends.
 *
 * The `/api/v1/*` request-origin guard (#426) rejects a request with no `Host`,
 * because at that trust boundary "absent" must mean "unproven", not "probably
 * local" — see `isLoopbackHostHeader`. Production never produces a Host-less
 * request (HTTP/1.1 requires the header and Node's parser enforces it), but
 * Hono's in-process test harness builds a bare `Request` that carries none, so
 * suites exercising the API have to supply it explicitly.
 *
 * Tests that assert on the guard itself should call `app.request()` directly —
 * they need to control (or omit) `Host` themselves.
 *
 * Generic over Hono's three type parameters rather than typed as the bare `Hono` default
 * (`Hono<BlankEnv, BlankSchema, '/'>`): a suite that mounts a route family directly — rather than
 * going through `createApp()` — builds a `new Hono<ProjectApiEnv>()`, and `Env` is INVARIANT in
 * Hono's handler positions, so the bare default rejects it. Adding the header is what this helper
 * does; the app's env and schema are none of its business.
 */
export async function apiRequest<E extends Env, S extends Schema, P extends string>(
  app: Hono<E, S, P>,
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('host')) headers.set('host', '127.0.0.1:4321');
  return app.request(input, { ...init, headers });
}
