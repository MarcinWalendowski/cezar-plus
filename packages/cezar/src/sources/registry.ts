import { CEZAR_HUB_SOURCE_KIND, createCezarHubSourceProvider } from './cezar-hub/provider.ts';
import { createNotionSourceProvider, NOTION_SOURCE_KIND } from './notion/provider.ts';
import type { SourceProvider, SourceProviderDeps, SourceProviderFactory } from './provider-types.ts';
import type { SourceConnection } from './types.ts';

/**
 * `SOURCE_PROVIDERS` + `resolveSourceProvider` (F2, W2.2). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` phase "2.2" and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D1..D25.
 *
 * A second provider (Linear, Jira, Drive) is one new file plus one row in `SOURCE_PROVIDERS` —
 * no contract change, no route change, no UI change (spec Q2). Resolution is keyed on the
 * connection's own declared `kind` string, never on a git remote or any other repo-derived signal:
 * a Notion workspace has no such remote, which is exactly the resolvability gap this seam exists
 * to close.
 */

export const SOURCE_PROVIDERS: Record<string, SourceProviderFactory> = {
  [NOTION_SOURCE_KIND]: createNotionSourceProvider,
  // The hub's own corpus, mirrored down to a node that must be able to READ the record without
  // being where it lives (D8a of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`). This row is
  // the first OUTSIDE test of the promise the docblock above makes — one new file plus one row,
  // with no contract, route or UI change — and it held: `cezar-hub` needed neither. Its provider
  // is a typed stub whose `detect()` honestly reports unavailable until package 3b.1 lands the
  // body, which is what keeps `GET /api/v1/sources/providers` answering rather than throwing.
  [CEZAR_HUB_SOURCE_KIND]: createCezarHubSourceProvider,
};

/**
 * Looks `connection.kind` up in `SOURCE_PROVIDERS` and constructs a bound provider. Returns `null`
 * for an unknown kind — never throws — so a stale or mistyped `kind` in `sources.json` degrades to
 * "no provider available" rather than crashing the caller. The `connection` parameter only needs
 * `kind` to resolve the factory; a full `SourceConnection` is required to actually construct one,
 * matching the shape every real caller (the sweep, the routes) already has.
 */
export function resolveSourceProvider(
  connection: Pick<SourceConnection, 'kind'> & Partial<Omit<SourceConnection, 'kind'>>,
  deps?: SourceProviderDeps,
): SourceProvider | null {
  const factory = SOURCE_PROVIDERS[connection.kind];
  if (!factory) return null;
  return factory(connection as SourceConnection, deps);
}
