import type {
  AgentConfigFileContent,
  AgentAccountDetailsResponse,
  AgentAccountStatusResponse,
  AgentProfileResponse,
  AgentProfileSelectionsResponse,
  AccountUsageResponse,
  AgentProfilesResponse,
  CreateAgentProfileInput,
  DiscoveredAgentAccountsResponse,
  OpenAgentAccountFileInput,
  OpenAgentAccountFileResponse,
  RemoveAgentProfileResponse,
  SelectAgentProfileInput,
  UpdateAgentProfileInput,
  AutomationsResponse,
  AutomationCheck,
  AutomationCheckQueuedResponse,
  AutomationLogResponse,
  AutomationResponse,
  CreateAutomationInput,
  UpdateAutomationInput,
  AgentConfigListing,
  ApiRun,
  ArchiveFinishedResponse,
  MarkAllReadResponse,
  CancelAutoResumeResponse,
  CancelResponse,
  ChangesPayload,
  CheckoutProjectInput,
  CreateBlankProjectInput,
  ConfigResponse,
  CreateTodoInput,
  CreateTodoResponse,
  ReclaimWorktreesResponse,
  RemoveWorktreeResponse,
  WorktreesResponse,
  ContinueResponse,
  CreatePrResponse,
  CreateRunInput,
  CreateRunResponse,
  DeleteRunResponse,
  DeleteWorkflowResponse,
  FinishResponse,
  FsBrowseResponse,
  GitCommitResponse,
  GitInitResponse,
  GitPreflightResponse,
  GitPushResponse,
  GithubChecksData,
  GithubRefStatusData,
  GithubCommentsData,
  GithubData,
  GithubMergeMethod,
  GithubMergeResponse,
  GithubPrMergeStateResponse,
  GithubPrChangesData,
  GroupResponse,
  HealthResponse,
  HostMetricsResponse,
  ImageInput,
  LaunchKeyResponse,
  MessageInput,
  EditQueuedMessageResponse,
  MessageResponse,
  RemoveQueuedMessageResponse,
  OpenInCliResponse,
  OpenProjectInResponse,
  OpenTargetsResponse,
  ParsedWorkflow,
  PatchRunInput,
  PickVariantResponse,
  PlanResponse,
  ProviderConnectResponse,
  ProviderId,
  ProviderStatusResponse,
  ProjectScanResponse,
  ProjectsResponse,
  RegisterProjectResponse,
  RemoveProjectResponse,
  UpdateProjectInput,
  UpdateProjectResponse,
  RemoveTodoResponse,
  RepoBranchResponse,
  RepoCommitPayload,
  RunCommitsResponse,
  RunHistoryContext,
  RunHistoryPage,
  RepoResponse,
  SpecReviewFeedResponse,
  AnalyticsEvent,
  AnalyticsEventsResponse,
  Runner,
  ModelDiscoveryRunner,
  RunnerModelCatalogResponse,
  RunRecord,
  RunsIndexResponse,
  WorktreeEntry,
  SaveWorkflowInput,
  SaveWorkflowResponse,
  SetConfigInput,
  SetConfigResponse,
  SetAgentConfigInput,
  SetWorkspaceConfigInput,
  SetWorkspaceUiStateInput,
  ImportableSkill,
  Skill,
  StartTodoResponse,
  TodoItem,
  UpdateTodoInput,
  UpdateTodoResponse,
  UiState,
  WorkflowsResponse,
  WorkspaceConfigResponse,
  WorkspaceUiState,
  // Central-hub scaffold (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`) — the five inert
  // families' GET response shapes. Mutator wrappers are deliberately NOT added yet: every
  // mutating route answers ONLY a 409 today (D19), with no 2xx branch for a wrapper to type
  // against, so there is nothing real to wrap. Each wave that gives its family a real success
  // response (W4.1, W4.6, W4.7, P2.3, W4.10) adds the matching mutator function here.
  KnowledgeResponse,
  KnowledgeSearchResponse,
  KnowledgeDocumentsResponse,
  KnowledgeProposalsResponse,
  KnowledgeDocumentResponse,
  // Report triage (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`) — rides the knowledge
  // base, and unlike the scaffold families above it ships with real success branches on every
  // mutator, so the mutator wrappers belong here from the start.
  ReportsResponse,
  ReportDetailResponse,
  ReportApproveResponse,
  ReportDismissResponse,
  ReportReopenResponse,
  ReportProcessPendingResponse,
  ReportStatus,
  SourcesListResponse,
  SourceProvidersResponse,
  SourceCollectionsResponse,
  SourceDocumentsResponse,
  SourceDocumentResponse,
  SourceCommentsResponse,
  SourceLogResponse,
  NotesListResponse,
  NoteResponse,
  NoteRemovedResponse,
  ProcessNoteResponse,
  ApproveNoteResponse,
  CreateNoteInput,
  UpdateNoteInput,
  ApproveNoteInput,
  RejectNoteInput,
  WorkspaceRunsResponse,
  WorkspaceTodosResponse,
  FiledPartition,
  FiledSortColumn,
  FiledSortDir,
  FiledViewValue,
  WorkspaceTodosQuery,
  AnalyticsEventsRequest,
  AnalyticsEventsResponse,
  WorkspaceGitResponse,
  WorkspaceKnowledgeSearchResponse,
  WorkspaceKnowledgeDomainsResponse,
  WorkspaceKnowledgeDocumentResponse,
  NotificationsResponse,
  NotificationLogResponse,
  NotificationLogStatus,
  WorkspaceRunStartInput,
  WorkspaceRunStartResponse,
  BackupOverviewResponse,
  BackupSnapshotsResponse,
  BackupRunResponse,
  BackupRestoreInput,
  BackupRestoreResponse,
  BackupVerifyResponse,
  BackupGcResponse,
} from '@loki-labs/better-cezar-api-client'
import { parseProviderStatusResponse } from '@/lib/provider-status'
import {
  API_PREFIX,
  apiPath,
  createCezarClient,
  getApiBaseUrl,
  getApiScope,
  queryScope,
  runHistoryContextSchema,
  runHistoryPageSchema,
} from '@loki-labs/better-cezar-api-client'
import type { Ok, OkJson } from '@loki-labs/better-cezar-api-client'
import type { ClientResponse } from 'hono/client'
import type { ResponseFormat } from 'hono/types'
import type { AppType } from '@loki-labs/better-cezar/app-type'

/**
 * The cockpit's client for its own HTTP API.
 *
 * Same-origin by construction: the Hono server serves this bundle and owns `/api/v1/*`, and the
 * Vite dev server proxies `/api` to it. So every URL here is root-relative — there is no base
 * URL to configure and no cross-origin case to get wrong.
 *
 * Calls name a ROUTE (`/runs/:id/diff`), never a URL: `apiPath` (api-client) adds the version
 * and, when a project scope is active, the `/p/<id>` segment. That is why the version appears
 * once in this repo rather than at every call site. `runFileRawUrl` is the one URL this module
 * hands out instead of fetching itself, so it resolves the route at build time.
 *
 * This module is the boundary. It parses responses, turns every non-2xx into an `ApiError`
 * carrying the server's own words, and does nothing else: no caching, no retries, no
 * reconnect. Freshness is SSE's job and TanStack Query's (queries.ts, and Step 3.2's reconcile).
 *
 * Every call goes through the typed client (`cez`/`unwrap` below), which checks the route against
 * the server's own handlers. Three functions keep their own `fetch` for a reason `hc` cannot
 * express, and each says which in its own comment: `registerProject` (a 409 is a SUCCESS for the
 * add-project flow), `requestText` (the routes that answer `text/plain`), and `runFileRawUrl`
 * (a URL handed to an `<img>`, never fetched). All of them end in the same `ApiError` contract,
 * so a caller cannot tell which path a given function uses.
 */

/**
 * A failed API call.
 *
 * `message` is the server's `{ error }` verbatim wherever it sent one, because it writes those
 * for the person reading them — "run is active — cancel it first", "no terminal emulator
 * found". Rewording them here would be inventing a worse error. The extras are the fields the
 * server pairs with specific 409s so the UI can offer the manual way out.
 */
export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server (offline, server stopped). */
  readonly status: number
  /** `POST /api/runs/:id/pr`: the `git merge <branch>` to run by hand when the PR failed. */
  readonly manual?: string
  /** `POST /api/runs/:id/open-in-cli`: the resume command, when no terminal could be opened. */
  readonly command?: string
  /** `POST /api/workflows`: the file is already there — the caller may retry with `overwrite`. */
  readonly exists?: boolean
  /**
   * An identity gate in front of cezar answered instead of cezar — a redirect off this origin
   * that a `fetch` may not follow (`.ai/specs/2026-08-19-signed-out-cockpit-reauth.md`).
   *
   * `status` is 0 because the request never reached the server, which is the same status an
   * offline failure carries; this flag is what tells the two apart. Without it a Cloudflare
   * Access bounce is indistinguishable from "the server is down", and the cockpit blames a
   * server that is answering fine. `lib/reauth.ts#isSignedOutError` is the reader.
   */
  readonly identityGate?: boolean

  constructor(
    status: number,
    message: string,
    extras: {
      manual?: string
      command?: string
      exists?: boolean
      identityGate?: boolean
      cause?: unknown
    } = {},
  ) {
    super(message, extras.cause !== undefined ? { cause: extras.cause } : undefined)
    this.name = 'ApiError'
    this.status = status
    this.manual = extras.manual
    this.command = extras.command
    this.exists = extras.exists
    this.identityGate = extras.identityGate
  }
}

export type ReadOptions = {
  /** Wired to TanStack Query's per-query signal, so an unmounted view stops its fetch. */
  signal?: AbortSignal
}

type Json = Record<string, unknown>

/** JSON.parse that answers "not JSON" instead of throwing — an error body is untrusted input:
 *  a proxy's HTML 502 page is as likely as the server's own `{ error }`. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Build the ApiError for a non-2xx, preferring the server's own message. */
function errorFor(status: number, statusText: string, body: string): ApiError {
  const parsed = parseJson(body)
  const json: Json = parsed && typeof parsed === 'object' ? (parsed as Json) : {}
  const message =
    str(json.error) ??
    // No `{ error }` — a proxy error page, an empty body, a crash. Say what we know rather
    // than leak a page of HTML into a toast.
    `${status} ${statusText || 'request failed'}`.trim()
  return new ApiError(status, message, {
    manual: str(json.manual),
    command: str(json.command),
    exists: typeof json.exists === 'boolean' ? json.exists : undefined,
  })
}

/**
 * The typed client over the same service (`@loki-labs/better-cezar-api-client`).
 *
 * Routes are being moved onto this one at a time. What it buys is compile-time checking of the
 * path, the request body and the response shape against the server's OWN handlers — the thing
 * the hand-written DTOs in this package approximate by hand and can drift from.
 *
 * It does NOT replace this module. `client.ts` stays the boundary: it owns `ApiError` (with the
 * server's own words), the credentials policy, and the non-JSON-body case. The typed client
 * only builds and sends the request; `unwrap` applies the same answer contract to whatever
 * comes back, so a migrated call behaves identically to a hand-written one.
 *
 * Not every route is ready. A handler that returns a loose type (`/health` answers
 * `Record<string, unknown>`) infers a weaker response than the DTO it replaces, so those wait
 * until the server tightens its own return types.
 */
const cez = createCezarClient<AppType>({
  // The base URL is resolved per request, not baked in at construction: this module is imported
  // before `main.tsx` configures it, and a `<meta>`-configured deployment must still take
  // effect. `hc` builds a root-relative URL, so prefixing here is the whole job.
  fetch: (input: string | URL | Request, init?: RequestInit) =>
    fetchOrThrow(withApiBase(String(input)), init),
})

/**
 * Prefix a root-relative URL the typed client built with the configured service origin.
 *
 * Also the one place the two request paths are reconciled on the wire. `hc` appends a `?` for
 * any `query` argument it is given, even one whose every value was optional and absent — an
 * equivalent URL, but not the one `apiPath` writes, and the stubs in this app's tests match on
 * the path they see.
 */
function withApiBase(url: string): string {
  const path = unscoped(url.endsWith('?') ? url.slice(0, -1) : url)
  return path.startsWith('/') ? `${getApiBaseUrl()}${path}` : path
}

/** The scoped spelling `hc` always builds for a project-scoped route, with no project mounted. */
const DEFAULT_SCOPE = `${API_PREFIX}/p/default`

/**
 * Drop the `/p/default` segment when no project scope is active.
 *
 * `hc` paths are static: a project-scoped route is spelled `p[':projectId']` at every call site
 * and the active scope goes in as `queryScope()`, which answers `'default'` when there is none.
 * That keeps ONE code path per call (the alternative was a branch per call), and the server
 * reserves `default` as the alias for the boot project, so both spellings reach the same handler.
 *
 * They are not the same URL, though, and this module's other half (`apiPath`) emits the
 * unprefixed one when unscoped. Normalising here — the single point every typed-client request
 * passes through — is what keeps an unscoped request byte-identical whichever half sent it, so
 * migrating a route never moves it on the wire.
 */
function unscoped(url: string): string {
  if (getApiScope() !== null || !url.startsWith(DEFAULT_SCOPE)) return url
  const rest = url.slice(DEFAULT_SCOPE.length)
  // Only a whole segment: a project genuinely called `default-ish` must keep its own prefix.
  return rest === '' || rest.startsWith('/') || rest.startsWith('?') ? `${API_PREFIX}${rest}` : url
}

/**
 * Apply this module's answer contract to a Response the typed client produced.
 *
 * Same three outcomes as `request()`: a non-2xx becomes an `ApiError` carrying the server's own
 * message, a non-JSON body becomes an `ApiError` naming the URL, anything else is the parsed
 * value — whose type the caller gets from the route, not from a hand-written declaration.
 */
/** The per-request options `hc` takes, from this module's `ReadOptions`. */
const init = (opts?: ReadOptions) => ({ init: { signal: opts?.signal } })

/**
 * Accepts a route that answers more than one FORMAT — `/repo/commit/:sha` serves a structured
 * payload or a raw blob on the same path, `/runs/:id/files` a listing or image bytes — and reads
 * the JSON branch. `OkJson` keeps that from becoming a hole: a route with no JSON branch at all
 * resolves to a branded error type rather than to `never`, which would have been assignable to
 * every caller's declared return type and failed only at runtime.
 */
async function unwrap<R extends ClientResponse<unknown, number, ResponseFormat>>(
  res: R,
  label: string,
): Promise<OkJson<R>> {
  const body = await res.text()
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  const parsed = parseJson(body)
  if (parsed === undefined) {
    throw new ApiError(res.status, `the cezar server answered ${label} with a non-JSON body`)
  }
  return parsed as OkJson<R>
}

/**
 * The `safeParse` half of a contract schema, spelled structurally.
 *
 * Keeps this package free of a direct `zod` dependency: the schemas arrive through the
 * api-client barrel as runtime values (`contract-pipeline.test.ts` pins that), and this is the
 * only part of them `unwrapValidated` uses.
 */
type ResponseValidator<T> = {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false }
}

/**
 * `unwrap`, plus the shape check its cast cannot make.
 *
 * `unwrap` ends in `parsed as OkJson<R>` — a compile-time claim about a body the server sent at
 * runtime. For most routes the claim is harmless: a caller reading a missing field gets
 * `undefined` and renders nothing. The history routes are different — `useRunHistory` iterates
 * `page.events`, so a 200 whose body is not a page throws a `TypeError` mid-render and takes the
 * session view down with it, bypassing the hook's own full-replay fallback (which only triggers
 * on a REJECTED query). Validating here turns that body into the same `ApiError` a non-JSON body
 * already produces, so the malformed case degrades exactly like the unreachable one.
 *
 * Its own server cannot produce such a body (`contract-parity.test.ts` pins both response types
 * to these schemas) — this guards the boundary against a proxy, a stale server, or a stub.
 */
async function unwrapValidated<R extends ClientResponse<unknown, number, ResponseFormat>>(
  res: R,
  label: string,
  schema: ResponseValidator<OkJson<R>>,
): Promise<OkJson<R>> {
  const status = res.status
  const parsed = await unwrap(res, label)
  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new ApiError(status, `the cezar server answered ${label} with an unexpected body`)
  }
  return result.data
}

/**
 * The one `fetch` both request paths go through — hand-written and typed alike.
 *
 * Shared rather than duplicated because the two behaviours below are the contract, and a
 * migrated route that quietly lost either of them would be a regression nobody sees until a
 * server is down:
 *
 * - **Credentials.** Remote installations are commonly behind reverse-proxy Basic Auth, and
 *   every background query/mutation must reuse that authenticated browser session just like
 *   navigation does. `include` is harmless for the root-relative, same-origin paths used here.
 * - **Unreachable is an `ApiError`, not a `TypeError`.** The request never got an answer — not
 *   an HTTP failure, hence status 0 — but callers get one error type either way instead of two.
 *   An abort is re-thrown untouched: that is the caller cancelling, not the server failing.
 */
async function fetchOrThrow(url: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { ...init, credentials: 'include', ...NO_REDIRECT })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, `cannot reach the cezar server (${url})`, { cause })
  }
  throwIfIdentityGate(res, url)
  return res
}

/**
 * Do not chase a redirect — report it (`.ai/specs/2026-08-19-signed-out-cockpit-reauth.md`).
 *
 * Spread into every request this cockpit makes, and safe on all of them **because no cezar route
 * answers 3xx to a fetch**: the only two `c.redirect(...)` calls in the whole server are
 * `/auth/login` and `/auth/callback` (`packages/cezar/src/auth/routes.ts`), and both are reached
 * by a top-level `<a href>` navigation. So a redirect arriving here never came from cezar — it
 * came from something in front of it.
 *
 * Following it is what hid the bug. `fetch` follows by default, so a Cloudflare Access bounce to
 * `https://<team>.cloudflareaccess.com/…` was chased off-origin, rejected by CORS, and surfaced
 * as a `TypeError` — which this module then reported as "cannot reach the cezar server", blaming
 * a server that was answering fine. Not following turns that bounce into a fact.
 */
export const NO_REDIRECT: Pick<RequestInit, 'redirect'> = { redirect: 'manual' }

/**
 * Throw when an identity gate in front of cezar answered instead of cezar.
 *
 * With `redirect: 'manual'` a browser hands back an **opaque redirect** — `type` is
 * `'opaqueredirect'`, `status` is 0, and nothing about it is readable, which is fine: the fact
 * that a cezar path redirected at all is the whole signal. The status check beside it is not
 * redundant — `fetch` implementations outside a browser (and the test stubs in this repo) surface
 * the real 3xx instead, and a detector that only works in one of the two would be a gate that
 * passes vacuously wherever it is tested.
 *
 * Exported because the three hand-rolled `/auth/*` probes (`onboarding-api.ts`, `teams-api.ts`,
 * `settings/account-api.ts`) each keep their own `fetch` for reasons their own comments give, and
 * an identity gate sits in front of *those* routes too. Their duplication is deliberate; this
 * check being duplicated four ways would not be — a copy that drifts is a tab that never
 * notices it is signed out.
 */
export function throwIfIdentityGate(res: Response, url: string): void {
  if (res.type === 'opaqueredirect' || REDIRECT_STATUSES.has(res.status)) {
    throw new ApiError(
      0,
      `signed out — ${url} was answered by an identity provider, not by cezar`,
      { identityGate: true },
    )
  }
}

/** The redirect statuses that carry a `Location`. Not "any 3xx": a `304` is a cache answer to a
 *  conditional request, not a gate turning us away. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

async function send(path: string, init: RequestInit): Promise<Response> {
  // Resolved here so the error names the URL that actually failed, not the route the caller
  // asked for — "cannot reach /health" would send someone looking for the wrong thing.
  return fetchOrThrow(apiPath(path), init)
}

/**
 * For the endpoints that answer `text/plain` (diffs, the handoff journal).
 *
 * These say so in `Accept`. Two of the server's routes now negotiate the representation from that
 * header when no query flag decides it (`/repo/commit/:sha`, `/runs/:id/files`), and a reader that
 * wants text should ASK for text rather than rely on a default — `fetch` would otherwise send
 * `*<slash>*`, which those routes deliberately read as "no preference". None of the callers here
 * is on a negotiating route today; the header is what keeps that true if one ever moves.
 */
async function requestText(path: string, init: RequestInit = {}): Promise<string> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'text/plain')
  const res = await send(path, { ...init, headers })
  const body = await res.text()
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  return body
}

const runPath = (id: string, suffix = ''): string => `/runs/${encodeURIComponent(id)}${suffix}`

// ---- reads --------------------------------------------------------------------------------

/** Version, update check, repo/branch, and the tool probes behind the Tools menu. */
export async function getHealth(opts?: ReadOptions): Promise<HealthResponse> {
  return unwrap(await cez.api.v1.health.$get({}, init(opts)), '/health')
}

/** Whole-host CPU%/memory% for the dashboard header. Workspace-level: one host per install. */
export async function getHostMetrics(opts?: ReadOptions): Promise<HostMetricsResponse> {
  return unwrap(await cez.api.v1['host-metrics'].$get({}, init(opts)), '/host-metrics')
}

/** Host-local catalog for one discovery runner (`codex`, `opencode` — #794). Workspace-level:
 *  one CLI/account serves every project. */
export async function getRunnerModels(
  runner: ModelDiscoveryRunner,
  opts?: ReadOptions,
): Promise<RunnerModelCatalogResponse> {
  return unwrap(await cez.api.v1.models.$get({ query: { runner } }, init(opts)), '/models')
}

/** Host-local authentication state shared by every project. */
export async function getProviderStatus(
  refresh = false,
  opts?: ReadOptions,
): Promise<ProviderStatusResponse> {
  return parseProviderStatusResponse(
    await unwrap(
      await cez.api.v1.providers.status.$get(
        { query: refresh ? { refresh: '1' } : {} },
        init(opts),
      ),
      '/providers/status',
    ),
  )
}

/** The bookmarklet auto-start secret (spec 011). Fetched to compare against `/new?key=` —
 *  never rendered, never logged, never put back into a URL. */
export async function getLaunchKey(opts?: ReadOptions): Promise<LaunchKeyResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId']['launch-key'].$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/launch-key',
  )
}

/** The workspace project registry (multi-project spec). Workspace-level — one registry no
 *  matter which project is active, so it has no project-scoped spelling.
 *
 *  Migrated to the typed client: the path and the response shape are checked against the
 *  server's handler, and `ProjectsResponse` here is an assertion that the inferred type still
 *  matches the DTO rather than the source of it. */
export async function getProjects(opts?: ReadOptions): Promise<ProjectsResponse> {
  return unwrap(await cez.api.v1.projects.$get({}, init(opts)), '/projects')
}

/** One directory listing for the folder picker (`GET /api/fs/browse`, step 4.1). `path`
 *  omitted means the independently configured browse root, so the dialog never has to know
 *  or duplicate that workspace setting. */
export async function browseFs(
  path?: string,
  opts?: ReadOptions & {
    /** Include dot-directories. Off by default (project folders are not hidden); ON for the
     *  agent-account picker, where EVERY candidate is one — `~/.claude-klaudiusz` and friends. */
    showHidden?: boolean
  },
): Promise<FsBrowseResponse> {
  return unwrap(
    // An absent `path` stays absent rather than becoming `?path=`: the server distinguishes
    // "no path" (the configured browse root) from an empty one only by `?? ''`, but `hc` drops
    // an `undefined` value entirely, which keeps the URL the one this call always sent. Same
    // reason `showHidden` is omitted rather than sent as `0`.
    await cez.api.v1.fs.browse.$get(
      {
        query: {
          path: path === '' ? undefined : path,
          ...(opts?.showHidden ? { showHidden: '1' } : {}),
        },
      },
      init(opts),
    ),
    '/fs/browse',
  )
}

/** Every git repo inside `path` (`GET /api/v1/projects/scan`, spec
 *  `.ai/specs/2026-08-14-nested-repos-as-projects.md`) — what lets "Add project" offer a nested
 *  repo as its own project. A READ: registering the ones the user keeps is still one
 *  `registerProject` call per row, through the guards every other add goes through. */
export async function scanProjectFolder(path: string, opts?: ReadOptions): Promise<ProjectScanResponse> {
  return unwrap(await cez.api.v1.projects.scan.$get({ query: { path } }, init(opts)), '/projects/scan')
}

/** What "Set up git" would do to `path` (`GET /api/v1/projects/git-preflight`, spec
 *  `.ai/specs/2026-08-15-import-all-folders-as-projects.md`). A read — and a thing to RENDER: the
 *  POST below re-runs every one of these checks server-side from the path alone. */
export async function preflightGitInit(path: string, opts?: ReadOptions): Promise<GitPreflightResponse> {
  return unwrap(
    await cez.api.v1.projects['git-preflight'].$get({ query: { path } }, init(opts)),
    '/projects/git-preflight',
  )
}

/** `git init` + first commit (`POST /api/v1/projects/git-init`). The body is the path and nothing
 *  else, deliberately: there is no field a client could use to skip a check. */
export async function initGitRepo(path: string): Promise<GitInitResponse> {
  return unwrap(await cez.api.v1.projects['git-init'].$post({ json: { path } }), '/projects/git-init')
}

/** The authoritative run list — sorted newest-first by the server. */
export async function getRuns(opts?: ReadOptions): Promise<ApiRun[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/runs',
  )
}

/** One project's run list by EXPLICIT id (`GET /api/p/:projectId/runs`, step 3.3): the sidebar
 *  reads non-active projects' tasks, which the active-scope `send()` prefix cannot reach. An
 *  already-`/api/p/`-prefixed path passes through `apiPath` untouched, so this stays
 *  correct whatever scope is mounted. */
export async function getProjectRuns(projectId: string, opts?: ReadOptions): Promise<ApiRun[]> {
  return unwrap(await cez.api.v1.p[':projectId'].runs.$get({ param: { projectId } }, init(opts)), '/runs')
}

/** The cross-project task index (`GET /api/v1/workspace/runs-index`) — what lets ⌘K find a task
 *  without knowing which project it lives in. Workspace-level like the registry, so it has no
 *  project-scoped spelling and never takes `queryScope()`. */
export async function getRunsIndex(opts?: ReadOptions): Promise<RunsIndexResponse> {
  return unwrap(await cez.api.v1.workspace['runs-index'].$get({}, init(opts)), '/workspace/runs-index')
}

export async function getRun(id: string, opts?: ReadOptions): Promise<ApiRun> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    runPath(id),
  )
}

/** One run by EXPLICIT project id (`GET /api/p/:projectId/runs/:id`) — the `getProjectRuns`
 *  pattern (step 3.3) applied to a single run, for a caller that already knows which project a
 *  run lives in without that project being the active scope. First consumer: the notes list's
 *  `ResultingRuns` row (D27 Phase 4a), reading a run's `stopReason` from a workspace-level page
 *  where no project is "active". */
export async function getProjectRun(projectId: string, id: string, opts?: ReadOptions): Promise<ApiRun> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].$get(
      { param: { projectId, id: encodeURIComponent(id) } },
      init(opts),
    ),
    runPath(id),
  )
}

/** One reverse-paged history page. Validated (not merely cast) because `useRunHistory` iterates
 *  `events`: see `unwrapValidated`. */
export async function getRunHistory(
  id: string,
  cursor?: string,
  opts?: ReadOptions,
): Promise<RunHistoryPage> {
  return unwrapValidated(
    await cez.api.v1.p[':projectId'].runs[':id'].history.$get(
      {
        param: { projectId: queryScope(), id: encodeURIComponent(id) },
        query: { ...(cursor !== undefined ? { cursor } : {}) },
      },
      init(opts),
    ),
    `${runPath(id)}/history`,
    runHistoryPageSchema,
  )
}

/** The compact current-state context for a run. Validated for the same reason as the page above. */
export async function getRunHistoryContext(id: string, opts?: ReadOptions): Promise<RunHistoryContext> {
  return unwrapValidated(
    await cez.api.v1.p[':projectId'].runs[':id']['history-context'].$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    `${runPath(id)}/history-context`,
    runHistoryContextSchema,
  )
}

export async function getUiState(opts?: ReadOptions): Promise<UiState> {
  return unwrap(
    await cez.api.v1.p[':projectId']['ui-state'].$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/ui-state',
  )
}

export async function getWorkflows(opts?: ReadOptions): Promise<WorkflowsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].workflows.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/workflows',
  )
}

export async function getSkills(opts?: ReadOptions): Promise<Skill[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.$get(
      // `query` is required once the route declares one, even when every key in it is optional
      // — `hc` drops the empty search string, so the URL is the one this call always sent.
      { param: { projectId: queryScope() }, query: {} },
      init(opts),
    ),
    '/skills',
  )
}

/** Wait for the server's already-started team-skill load. Used only after the fast catalog
 * read has rendered, so a cold clone never delays opening a skill picker. */
export async function getSkillsWhenReady(opts?: ReadOptions): Promise<Skill[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.$get(
      { param: { projectId: queryScope() }, query: { wait: '1' } },
      init(opts),
    ),
    '/skills',
  )
}

/** Refresh the team skills repos (spec 005: clone/fetch, degrade quietly offline) and answer
 *  the merged catalog — the Settings → Skills "Refresh" button. */
export async function refreshSkills(): Promise<Skill[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.refresh.$post({ param: { projectId: queryScope() } }),
    '/skills/refresh',
  )
}

/** The default (vendor) repo's full skill list — every skill the "Import skills" panel can
 *  offer, regardless of import state. Empty once a repo configures its own `skillsRepos`. */
export async function getImportableSkills(opts?: ReadOptions): Promise<ImportableSkill[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.importable.$get(
      { param: { projectId: queryScope() }, query: {} },
      init(opts),
    ),
    '/skills/importable',
  )
}

/** Wait for the server's already-started team-skill load before listing importable skills —
 *  the same cold-cache convergence as `getSkillsWhenReady`, off the panel's first render. */
export async function getImportableSkillsWhenReady(opts?: ReadOptions): Promise<ImportableSkill[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.importable.$get(
      { param: { projectId: queryScope() }, query: { wait: '1' } },
      init(opts),
    ),
    '/skills/importable',
  )
}

export async function getTodos(opts?: ReadOptions): Promise<TodoItem[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].todos.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/todos',
  )
}

/** File one project-scoped task without starting a run. */
export async function createTodo(input: CreateTodoInput): Promise<CreateTodoResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].todos.$post({
      param: { projectId: queryScope() },
      json: input,
    }),
    '/todos',
  )
}

export async function getRepo(opts?: ReadOptions): Promise<RepoResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/repo',
  )
}

/**
 * The Settings → Agents knobs in one read (`GET /api/config`, additive R6 route).
 *
 * `inherited`/`overridden` are materialized HERE rather than guarded at each read site, the same
 * boundary treatment `getWorkspaceConfig` gives `agentDefaults` and for the same reason: during
 * development the cockpit and the server can be different versions, and a server that predates
 * `.ai/specs/2026-08-21-one-settings-area.md` answers without them. An empty override list and an
 * all-null inherited block are exactly what "no machine tier" means, so the fallback is the truth
 * rather than a placeholder.
 */
export async function getConfig(opts?: ReadOptions): Promise<ConfigResponse> {
  const answer = await unwrap(
    await cez.api.v1.p[':projectId'].config.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/config',
  )
  return withConfigTiers(answer)
}

/** Shared by `getConfig` and `putConfig` — both answer the same shape (`configAnswer` builds
 *  both), so both need the same version-skew floor. */
function withConfigTiers(answer: ConfigResponse): ConfigResponse {
  return {
    ...answer,
    inherited: answer.inherited ?? {
      systemPrompt: null,
      liveTitleUpdates: null,
      reviewGate: null,
      stepBudget: null,
    },
    overridden: answer.overridden ?? [],
  }
}

/** The selected project's agent-owned config catalog and current file state. */
export async function getAgentConfig(opts: ReadOptions = {}): Promise<AgentConfigListing> {
  return unwrap(
    await cez.api.v1.p[':projectId']['agent-config'].$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/agent-config',
  )
}

/** One selected-project config file's raw contents and optimistic version. */
export async function getAgentConfigFile(
  id: string,
  opts: ReadOptions = {},
): Promise<AgentConfigFileContent> {
  return unwrap(
    await cez.api.v1.p[':projectId']['agent-config'][':id'].$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    `/agent-config/${encodeURIComponent(id)}`,
  )
}

/** Save inside the selected project scope; send() adds /api/p/:projectId. */
export async function putAgentConfigFile(
  id: string,
  body: SetAgentConfigInput,
): Promise<AgentConfigFileContent> {
  return unwrap(
    await cez.api.v1.p[':projectId']['agent-config'][':id'].$put({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: body,
    }),
    `/agent-config/${encodeURIComponent(id)}`,
  )
}

/** The main working tree's structured uncommitted diff vs HEAD (R5 repo view). 409 (as an
 *  ApiError with the reason) when the server runs outside a git repository. */
export async function getRepoChanges(opts?: ReadOptions): Promise<ChangesPayload> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.changes.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/repo/changes',
  )
}

/** One commit's structured diff (R5 repo view): `?structured=1` on the legacy commit route —
 *  additive, the text-blob answer stays for the legacy UI. 409 + reason for unknown shas. */
/*  NOT on the typed client, and it is the route that cannot be: the same handler answers the
 *  legacy `text/plain` blob when `?structured=1` is absent (a protected surface —
 *  BACKWARD_COMPATIBILITY.md §2), so `hc` infers a text member alongside the JSON one — one path,
 *  two formats. `unwrap` reads the JSON branch; `OkJson` is what stops that from also silently
 *  accepting a route that has no JSON branch at all. */
export async function getRepoCommit(sha: string, opts?: ReadOptions): Promise<RepoCommitPayload> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.commit[':sha'].$get(
      { param: { projectId: queryScope(), sha: encodeURIComponent(sha) }, query: { structured: '1' } },
      init(opts),
    ),
    '/repo/commit/:sha',
  )
}

/** A run's own commits (`<base>..HEAD`, newest first) for the task's Commits tab. */
export async function getRunCommits(id: string, opts?: ReadOptions): Promise<RunCommitsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].commits.$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    runPath(id, '/commits'),
  )
}

/** One of a run's commits, structured like the Changes tab. 409 for unknown shas. */
export async function getRunCommit(
  id: string,
  sha: string,
  opts?: ReadOptions,
): Promise<RepoCommitPayload> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].commit[':sha'].$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id), sha: encodeURIComponent(sha) } },
      init(opts),
    ),
    runPath(id, `/commit/${encodeURIComponent(sha)}`),
  )
}

/** The Spec tab's feed (spec `.ai/specs/2026-08-29-spec-tab-review-feed.md`, P3): the recorded
 *  spec/review side log when there is one, else the worktree fallback, else the empty answer.
 *  No 409 for a missing worktree — the recorded log alone is still worth serving. */
export async function getRunSpec(id: string, opts?: ReadOptions): Promise<SpecReviewFeedResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].spec.$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    runPath(id, '/spec'),
  )
}

/** Issues + PRs via the logged-in `gh`. Degrades to `{ available: false, reason }` server-side —
 *  an unreachable forge is a hint in the tab, not an ApiError. */
export async function getGithub(
  params: { limit?: number; refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.$get(
      {
        param: { projectId: queryScope() },
        // `refresh: false` sends nothing at all — the server tests `=== '1'`, and a parameter we
        // do not mean is how a "false" ends up read as truthy somewhere downstream.
        query: {
          limit: params.limit === undefined ? undefined : String(params.limit),
          refresh: params.refresh ? '1' : undefined,
        },
      },
      init(opts),
    ),
    '/github',
  )
}

/** Lazy PR checks glyphs for on-screen rows (#664). The list call no longer ships
 *  `statusCheckRollup`; this fills the glyph in per visible PR. Degrades to
 *  `{ available: false, reason }` server-side — a missing glyph, never an ApiError. */
export async function getGithubChecks(
  prNumbers: number[],
  opts?: ReadOptions,
): Promise<GithubChecksData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.checks.$get(
      { param: { projectId: queryScope() }, query: { prs: prNumbers.join(',') } },
      init(opts),
    ),
    '/github/checks',
  )
}

/**
 * Batched status for the PR/issue chips on screen. Takes its project EXPLICITLY, like
 * `getProjectRuns` and `archiveProjectRun` and for the same reason: the global Tasks page stands
 * outside every `/p/:projectId`, and its rows belong to different projects — `queryScope()` would
 * ask the boot project about another project's PR number and get a confident wrong answer.
 * Callers standing in one project pass their own id.
 *
 * Degrades to `{ available: false, reason }` server-side; an absent number is "nothing known",
 * which the chip renders exactly as it did before statuses existed.
 */
export async function getGithubRefStatus(
  projectId: string,
  refs: { prs?: readonly number[]; issues?: readonly number[] },
  opts?: ReadOptions,
): Promise<GithubRefStatusData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github['ref-status'].$get(
      {
        param: { projectId },
        query: {
          // Spread conditionally: the route reads an ABSENT key as "not asked for", and an empty
          // string would be a malformed list (a 400) rather than a silent no-op.
          ...(refs.prs?.length ? { prs: refs.prs.join(',') } : {}),
          ...(refs.issues?.length ? { issues: refs.issues.join(',') } : {}),
        },
      },
      init(opts),
    ),
    '/github/ref-status',
  )
}

/** The full comment thread for one issue/PR (#499). Degrades to `{ available: false, reason }`
 *  server-side — an unreachable thread is a one-line hint in the detail view, not an ApiError. */
export async function getGithubComments(
  kind: 'issue' | 'pr',
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubCommentsData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.comments[':kind'][':number'].$get(
      {
        param: { projectId: queryScope(), kind, number: String(number) },
        // `refresh=1` is what busts the route's 60 s `commentsCache` (server.ts). Without it a
        // manual refresh re-requests and is handed the same cached object — the caller must be
        // able to say "actually go and ask gh", exactly as `getGithub` can.
        query: { refresh: params.refresh ? '1' : undefined },
      },
      init(opts),
    ),
    `/github/comments/${kind}/${number}`,
  )
}

export async function getGithubPrMergeState(
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubPrMergeStateResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.prs[':number']['merge-state'].$get(
      {
        param: { projectId: queryScope(), number: String(number) },
        query: { refresh: params.refresh ? '1' : undefined },
      },
      init(opts),
    ),
    `/github/prs/${number}/merge-state`,
  )
}

export async function mergeGithubPr(
  number: number,
  input: { method: GithubMergeMethod; expectedHeadSha: string; overrideRules?: boolean },
): Promise<GithubMergeResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.prs[':number'].merge.$post({
      param: { projectId: queryScope(), number: String(number) },
      json: input,
    }),
    '/github/prs/:number/merge',
  )
}

export async function getGithubPrChanges(
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubPrChangesData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.prs[':number'].changes.$get(
      {
        param: { projectId: queryScope(), number: String(number) },
        query: { refresh: params.refresh ? '1' : undefined },
      },
      init(opts),
    ),
    `/github/prs/${number}/changes`,
  )
}

/** The run's worktree diff against its base, as unified-diff text. Also the plain-text
 *  "(no worktree — …)" sentence for runs that executed in the repo working tree. */
export function getRunDiff(id: string, opts?: ReadOptions): Promise<string> {
  return requestText(runPath(id, '/diff'), { method: 'GET', signal: opts?.signal })
}

/** The run's handoff journal (spec 007) as markdown text. `''` until the file is seeded —
 *  the server only 404s for an unknown run, never for a missing file. */
export function getRunHandoff(id: string, opts?: ReadOptions): Promise<string> {
  return requestText(runPath(id, '/handoff'), { method: 'GET', signal: opts?.signal })
}

/** The run's structured working-directory-vs-base diff (R5): per-file status/±/patch + the
 *  aggregate stat. Worktree-off runs read the repo checkout they executed in. */
export async function getRunChanges(id: string, opts?: ReadOptions): Promise<ChangesPayload> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].changes.$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    runPath(id, '/changes'),
  )
}

/** One worktree path (R5 Files tab; also the Changes tab's expandable-context source):
 *  a directory listing, or a file with content unless binary/too large. */
export async function getRunFile(id: string, path: string, opts?: ReadOptions): Promise<WorktreeEntry> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].files.$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) }, query: { path } },
      init(opts),
    ),
    '/runs/:id/files',
  )
}

/** The same-origin URL an `<img>` can load an image file's bytes from (R5 Files tab). The
 *  server serves raw ONLY for image extensions within the size cap — everything else 409s.
 *  Scoped here rather than in send() — this URL is handed to an `<img>`, never fetched. */
export function runFileRawUrl(id: string, path: string): string {
  return apiPath(runPath(id, `/files?path=${encodeURIComponent(path)}&raw=1`))
}

/** The variant-compare data (spec 010): one entry per variant of the group, with the legacy
 *  `git diff --stat` text and the handoff Progress excerpt. 404 for an unknown group. */
export async function getGroup(groupId: string, opts?: ReadOptions): Promise<GroupResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].groups[':groupId'].$get(
      { param: { projectId: queryScope(), groupId: encodeURIComponent(groupId) } },
      init(opts),
    ),
    `/groups/${encodeURIComponent(groupId)}`,
  )
}

// ---- workspace mutations ------------------------------------------------------------------

/**
 * Open a terminal signed in to `provider`, optionally for a NAMED account.
 *
 * `profileId` aims the login at one agent account (spec 2026-07-29-agent-profiles): the server
 * renders `CLAUDE_CONFIG_DIR=… claude /login` for it and fails closed rather than running the bare
 * command, because a terminal silently pointed at the wrong account is invisible to the user.
 * Omitted means the discovered account, which is how the Providers card has always called this.
 */
export async function connectProvider(
  provider: ProviderId,
  profileId?: string,
): Promise<ProviderConnectResponse> {
  return unwrap(
    await cez.api.v1.providers.connect.$post({
      json: { provider, ...(profileId ? { profileId } : {}) },
    }),
    '/providers/connect',
  )
}

export async function setProviderEnabled(
  provider: ProviderId,
  enabled: boolean,
): Promise<ProviderStatusResponse> {
  return parseProviderStatusResponse(
    await unwrap(
      await cez.api.v1.providers[':provider'].enabled.$put({
        param: { provider },
        json: { enabled },
      }),
      `/providers/${encodeURIComponent(provider)}/enabled`,
    ),
  )
}

export async function retryProviderAuth(
  provider: ProviderId,
  authFailureId: string,
): Promise<ProviderStatusResponse> {
  return parseProviderStatusResponse(
    await unwrap(
      await cez.api.v1.providers[':provider'].retry.$post({
        param: { provider },
        json: { authFailureId },
      }),
      `/providers/${encodeURIComponent(provider)}/retry`,
    ),
  )
}

/**
 * Register an existing folder (`POST /api/projects`, step 4.2).
 *
 * The one call in this module that does not funnel through `request()`: a 409 (already
 * registered) is NOT a failure for the add-project flow — the server answers it with the
 * EXISTING entry, which is exactly what the dialog needs to navigate to. Every other non-2xx
 * still becomes the same ApiError as anywhere else.
 *
 * `teamId` is additive (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phase 4/5's
 * project→team mapping): the onboarding wizard's "add projects" step is the one caller that
 * passes it, so a project registered there is assigned to the caller's team in the same request
 * instead of a second call. Every other caller omits it, and the body sent is byte-identical to
 * before.
 */
export async function registerProject(root: string, teamId?: string): Promise<RegisterProjectResponse> {
  const path = '/projects'
  const res = await send(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, ...(teamId ? { teamId } : {}) }),
  })
  const body = await res.text()
  const parsed = parseJson(body)
  const project = (parsed as { project?: unknown } | undefined)?.project
  if ((res.ok || res.status === 409) && project !== undefined && project !== null) {
    return parsed as RegisterProjectResponse
  }
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  throw new ApiError(res.status, `the cezar server answered ${path} without a project`)
}

/**
 * Clone a GitHub repo into the checkout root and register it (`POST /api/projects/checkout`,
 * step 4.3).
 *
 * On the typed client, unlike `registerProject` above: every non-2xx here IS a failure the dialog
 * must show (a 409 means the target folder exists, and there is no entry to navigate to), so
 * `unwrap`'s ordinary contract is the right one. It surfaces the server's `{ error }` string as
 * the ApiError message, which is exactly what the dialog renders — a clone fails for reasons only
 * the server can name.
 *
 * No timeout of our own: cloning a large repo legitimately takes minutes, and the request is
 * what the dialog waits on. Progress meanwhile comes from `checkout-progress` on the workspace
 * stream, keyed by `input.checkoutId`.
 */
export async function checkoutProject(input: CheckoutProjectInput): Promise<RegisterProjectResponse> {
  return unwrap(await cez.api.v1.projects.checkout.$post({ json: input }), '/projects/checkout')
}

/**
 * Create a blank project — a new folder under the configured projects dir, `git init`ed and
 * registered (`POST /api/v1/projects/blank`, D15).
 *
 * `unwrap`'s ordinary contract, for exactly `checkoutProject`'s reason above and not
 * `registerProject`'s: every non-2xx here is a real failure with nothing to navigate to. In
 * particular the 409 means a folder of that name already exists and this route deliberately
 * refuses to adopt it — "create blank" must never silently hand back someone else's directory —
 * so it is an error the dialog shows, not a success to follow.
 */
export async function createBlankProject(input: CreateBlankProjectInput): Promise<RegisterProjectResponse> {
  return unwrap(await cez.api.v1.projects.blank.$post({ json: input }), '/projects/blank')
}

/**
 * Deregister a project (`DELETE /api/projects/:projectId`, step 4.4).
 *
 * Registry-only by contract — the server deletes NOTHING under the project root — so this
 * never needs an "are you sure you have a backup" ceremony beyond the pane's own confirm.
 * Ordinary `unwrap`: the 409s (running tasks, the boot project) are real failures whose
 * `{ error }` message is what the pane shows, and `errorFor` already surfaces it.
 */
export async function removeProject(projectId: string): Promise<RemoveProjectResponse> {
  return unwrap(
    await cez.api.v1.projects[':projectId'].$delete({ param: { projectId: encodeURIComponent(projectId) } }),
    `/projects/${encodeURIComponent(projectId)}`,
  )
}

/**
 * Set or clear a project's per-project concurrency ceiling, and/or reassign its team
 * (`PATCH /api/v1/projects/:projectId`, spec 2026-07-22 + `.ai/specs/2026-08-06-org-team-auth-
 * onboarding.md` D2/D4 Phase 5c). `maxParallel: null` clears the override back to "inherit the
 * workspace cap"; an integer pins it; `undefined` (simply omitted) leaves it untouched — the ROUTE
 * (`server.ts`, widened 2026-08-07, Fill unit 3) now distinguishes "clear" from "don't touch",
 * which is what makes a `teamId`-only call safe. The server applies the new ceiling live (semaphore
 * refresh) and reports the reassigned team back through the SAME `withTeams` decoration the GET
 * listing uses, so the answer is the fully up-to-date entry the pane swaps into its list.
 *
 * Deliberately NOT where a project's agent account is set — that is
 * `selectAgentProfile` (`PUT /api/v1/workspace/agent-profiles/selection`), so
 * the selection is stored beside the accounts it names.
 *
 * **The body is forwarded WHOLE, and that is the point.** This used to rebuild it key by key —
 * originally to dodge a `?? null` trap, when `$patch`'s typed `json` still required the narrower
 * pre-`teamId` `{maxParallel: number | null}` and an unqualified `input.maxParallel ?? null` would
 * have CLEARED a concurrency override on every team-only reassignment. That list then went stale:
 * `tags` was added to the contract (2026-08-10) and to the route, and this function kept sending
 * `{ maxParallel?, teamId? }`, so every tag edit PATCHed an empty body. The server left the project
 * untouched and answered with it, `onSuccess` replaced the optimistic row with that answer, and the
 * tag vanished a beat after it appeared — a hand-maintained whitelist over a contract that grows.
 *
 * `useUpdateProject` one layer up already forwards its variables whole for exactly this reason
 * ("an unlisted key would be silently dropped instead of sent"); this now matches. `undefined`
 * values disappear in JSON serialization, which is precisely the route's "absent means untouched"
 * contract, and the typed `json` is inferred from `server.ts`'s own validator, so a field the route
 * does not accept cannot compile.
 */
export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
): Promise<UpdateProjectResponse> {
  return unwrap(
    await cez.api.v1.projects[':projectId'].$patch({
      param: { projectId: encodeURIComponent(projectId) },
      json: input,
    }),
    `/projects/${encodeURIComponent(projectId)}`,
  )
}

// ---- run mutations ------------------------------------------------------------------------

/** ×1 answers the run record; ×2/×3 answers `{ runs }` — narrow on `'runs' in result`. */
export async function createRun(input: CreateRunInput): Promise<CreateRunResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs.$post({ param: { projectId: queryScope() }, json: input }),
    '/runs',
  )
}

export async function cancelRun(id: string): Promise<CancelResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].cancel.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/cancel'),
  )
}

/** Archives by default; pass `false` to bring a run back into the live list. */
export async function archiveRun(id: string, archived = true): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].archive.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { archived },
    }),
    runPath(id, '/archive'),
  )
}

/**
 * Archive by EXPLICIT project, for the cross-project board — the twin of `getProjectRuns`, and
 * for the same reason: the global Tasks page stands outside every `/p/:projectId`, so
 * `queryScope()` would send the BOOT project's id for a row that belongs to another project, and
 * the archive would either 404 or (with a colliding id) land on the wrong task. Every caller that
 * is already standing in the run's own project keeps using `archiveRun`.
 *
 * **Moved off `/p/:projectId` on 2026-08-14** (`.ai/specs/2026-08-14-cross-project-run-mutations.md`).
 * It used to POST to `/api/v1/p/:projectId/runs/:id/archive`, and that prefix carries a
 * method-agnostic `use('*')` scope resolver which BUILDS the named project's context: prune
 * orphans, reclaim (delete) worktrees, then `manager.recover()` — resuming every interrupted run
 * in that project. Archiving one finished row therefore started processes in a project the user
 * had only pointed at. The workspace spelling has no `:projectId` scope for the resolver to act
 * on, so the id is data the handler resolves instead.
 */
export async function archiveProjectRun(
  projectId: string,
  id: string,
  archived = true,
): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.workspace.runs[':projectId'][':runId'].archive.$post({
      param: { projectId, runId: encodeURIComponent(id) },
      json: { archived },
    }),
    runPath(id, '/archive'),
  )
}

/**
 * The read receipt by EXPLICIT project — the twin of `archiveProjectRun`, and for the same
 * reason: the global Tasks page stands outside every `/p/:projectId`, so `queryScope()` would
 * stamp the receipt on the boot project. `read: false` is the inverse route (#775).
 *
 * On the workspace spelling since 2026-08-14, for the reason `archiveProjectRun` spells out — and
 * this one is the sharper case: a read receipt is what the board stamps automatically as you look
 * at rows, so the old path made *reading the board* resume other projects' runs.
 */
export async function setProjectRunRead(
  projectId: string,
  id: string,
  read: boolean,
): Promise<RunRecord> {
  const route = read ? 'read' : 'unread'
  return unwrap(
    await (read
      ? cez.api.v1.workspace.runs[':projectId'][':runId'].read.$post({
          param: { projectId, runId: encodeURIComponent(id) },
        })
      : cez.api.v1.workspace.runs[':projectId'][':runId'].unread.$post({
          param: { projectId, runId: encodeURIComponent(id) },
        })),
    runPath(id, `/${route}`),
  )
}

/** Stop THIS task from resuming itself after a usage limit (spec
 *  2026-08-03-auto-resume-after-usage-limit) — the per-task twin of the workspace setting.
 *  Idempotent: a task with nothing scheduled answers the same way. */
export async function cancelAutoResume(id: string): Promise<CancelAutoResumeResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['auto-resume'].$delete({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/auto-resume'),
  )
}

/** Sweep every finished (done/failed/cancelled) active run into the archive in one call —
 *  the Tasks header's "Archive finished" button. */
export async function archiveFinished(): Promise<ArchiveFinishedResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs['archive-finished'].$post({
      param: { projectId: queryScope() },
    }),
    '/runs/archive-finished',
  )
}

/** Read receipt (#unread-done-items): opening a task's thread marks it read. Bodyless —
 *  the server stamps `seenAt = now` and answers with the updated record. */
export async function markRunSeen(id: string): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].read.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/read'),
  )
}

/** Put a finished task back to unread (#775): the inverse of `markRunSeen`. Bodyless — the
 *  server CLEARS `seenAt` (an absent receipt is what every reader already treats as unread)
 *  and answers with the updated record. */
export async function markRunUnseen(id: string): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].unread.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/unread'),
  )
}

/** "Mark all read": stamp every currently-unread finished run in one call. */
export async function markAllRunsSeen(): Promise<MarkAllReadResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs['read-all'].$post({
      param: { projectId: queryScope() },
    }),
    '/runs/read-all',
  )
}

/** Close a waiting session gracefully — the run completes as done. 409 when nothing is open. */
export async function finishRun(id: string): Promise<FinishResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].finish.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/finish'),
  )
}

/** The follow-up composer's optional overrides for a Continue (#401): pick which backend and
 *  model handle the reopened session. Omitted fields keep the run's current backend/model.
 *  `text`/`images` are the prompt the reopened session starts on — omitted, the engine opens
 *  with its plain "Continue.". */
export interface ContinueOptions {
  text?: string
  images?: ImageInput[]
  runner?: Runner
  model?: string
}

/** Reopen a finished run's session. 409 (with the reason) when it cannot be resumed. An optional
 *  runner/model override lets the follow-up choose the engine; omitted keeps the run's current
 *  backend (backward compat). */
/**
 * Decide a run parked on a step's human approval gate (spec
 * `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`).
 *
 * Both routes answer 409 when the run exists but is not parked — the caller renders that as
 * "somebody already decided this" rather than as a failure, because it usually means a second
 * reviewer got there first.
 */
export async function approveRun(id: string, note?: string): Promise<unknown> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].approve.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: note ? { note } : {},
    }),
    runPath(id, '/approve'),
  )
}

/** `notes` is required: it is handed to the spec step as its rework instructions. */
export async function requestRunChanges(id: string, notes: string): Promise<unknown> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['request-changes'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { notes },
    }),
    runPath(id, '/request-changes'),
  )
}

/**
 * Ask the server to re-probe a manual handoff.
 *
 * The return type is load-bearing, and it used to be `unknown`. This endpoint answers **200 with
 * `resolved: false`** when the probes ran and still say no — a refusal, not an error — so a caller
 * that discards the body treats every refusal as a success. That is exactly what the handoff card
 * did: five presses on a red deploy park produced five server-side "still red" notes and nothing
 * on screen (measured 2026-08-29, run cc25d636). Read `resolved` before you believe it worked.
 */
export async function resolveRunHandoff(
  id: string,
  note?: string,
): Promise<{ resolved: boolean; verdict: string }> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].handoff.resolve.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: note ? { note } : {},
    }),
    runPath(id, '/handoff/resolve'),
  )
}

export async function skipRunHandoff(id: string, note: string): Promise<unknown> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].handoff.skip.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { note },
    }),
    runPath(id, '/handoff/skip'),
  )
}

export async function continueRun(id: string, opts: ContinueOptions = {}): Promise<ContinueResponse> {
  const body = {
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    ...(opts.images !== undefined ? { images: opts.images } : {}),
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  }
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].continue.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: body,
    }),
    runPath(id, '/continue'),
  )
}

/** Which engine to move a PARKED task to (spec `2026-08-23-retarget-task-to-another-engine.md`).
 *  Every field optional and only the ones the user actually changed are sent — an omitted field
 *  means "keep what the run has", so a person who touches only the model does not silently also
 *  re-pin the account they never opened. `agentProfile` is accepted only for a task that has not
 *  started: a run with a session is tied to the login that created it, and the server answers 409
 *  rather than dropping the field. */
export interface RetargetOptions {
  runner?: Runner
  agentProfile?: string
  model?: string
}

/** Move a queued or scheduled task to another engine (`POST /api/runs/:id/agent`).
 *
 *  409 with the reason when the run is not in a state that can move — most usefully when it is
 *  already running, which is the race a person hits by pressing the button just as a slot opens.
 *  The caller renders that reason; it is never a silent no-op. */
export async function retargetRun(id: string, opts: RetargetOptions = {}): Promise<unknown> {
  const body = {
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    ...(opts.agentProfile !== undefined ? { agentProfile: opts.agentProfile } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  }
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].agent.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: body,
    }),
    runPath(id, '/agent'),
  )
}

/** Draft PR from the review gate (spec 009): push the branch, `gh pr create --draft`; the run
 *  completes as done with the PR badge. On 409 the ApiError's `manual` carries the
 *  `git merge <branch>` fallback to show copyable. */
export async function createRunPr(id: string): Promise<CreatePrResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].pr.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/pr'),
  )
}

/** Rename a run (#389): the edit becomes the display title and wins over any auto-summary. */
export async function patchRun(id: string, patch: PatchRunInput): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].$patch({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: patch,
    }),
    runPath(id),
  )
}

/** Deletes the run, its transcript, its worktree and its branch. 409 while it is still active. */
export async function deleteRun(id: string): Promise<DeleteRunResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].$delete({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id),
  )
}

/** Inbox "Dismiss" (spec 007): check the follow-up off — the server deletes the entry. */
export async function removeTodo(id: string): Promise<RemoveTodoResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].todos[':id'].$delete({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    `/todos/${encodeURIComponent(id)}`,
  )
}

/** The Inbox card's optional backend choice + extra instructions for a Run. Unlike
 *  `ContinueOptions` these start a NEW run, so an omitted `runner`/`model` means the host's
 *  `defaultRunner`, not "keep the run's". `prompt` (#413) is extra instructions appended to the
 *  suggested/summary task text — e.g. a template inserted in the Inbox composer. */
export interface StartTodoOptions {
  runner?: Runner
  model?: string
  prompt?: string
}

/** Inbox "Run" (spec 007): the server turns the entry into a task — a one-off single-step
 *  workflow around the suggested skill when it exists, plain quick-task otherwise — and
 *  answers 201 with the new run. 409 when the entry was already started. An optional
 *  runner/model (#401) picks the engine and an optional `prompt` (#413) appends instructions;
 *  with neither, sends no body at all — the pre-#401/#413 bodyless POST, kept for compat. */
export async function startTodo(
  id: string,
  opts: StartTodoOptions = {},
): Promise<StartTodoResponse> {
  const body = {
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
  }
  // No override → no body at all, exactly the bodyless POST this endpoint has always sent
  // (`continueRun` posts `{}` because it always carried one). The server tolerates either, and
  // `hc` sends nothing for an `undefined` json — no body AND no content-type, which is the same
  // request `mutate(…, undefined)` used to build.
  return unwrap(
    await cez.api.v1.p[':projectId'].todos[':id'].start.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: Object.keys(body).length > 0 ? body : undefined,
    }),
    `/todos/${encodeURIComponent(id)}/start`,
  )
}

/**
 * Start a todo that lives in a NAMED project rather than the active one.
 *
 * Same route and same server behaviour as `startTodo` above — the only difference is that the
 * `projectId` param comes from the caller instead of `queryScope()`. That difference is the whole
 * point: the workspace Tasks board lists todos from every project at once, so starting the row
 * for `chat` while the cockpit's active scope is `cockpit-boot` must start it in `chat`. Reusing
 * `startTodo` there would silently run it in whatever project you happened to be looking at.
 */
export async function startWorkspaceTodo(
  projectId: string,
  id: string,
  opts: StartTodoOptions = {},
): Promise<StartTodoResponse> {
  const body = {
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
  }
  return unwrap(
    await cez.api.v1.p[':projectId'].todos[':id'].start.$post({
      param: { projectId, id: encodeURIComponent(id) },
      json: Object.keys(body).length > 0 ? body : undefined,
    }),
    `/todos/${encodeURIComponent(id)}/start`,
  )
}

/**
 * The Filed table's status/priority edit and its Archive/Restore action
 * (2026-08-17-filed-tasks-table-statuses.md) — one PATCH, project named explicitly.
 *
 * Same shape as `startWorkspaceTodo` above and for the same reason: the Filed table lists todos
 * from every project at once, so `queryScope()` would stamp the edit on the boot project rather
 * than the row's own. `patch` must carry at least one key — the server's `.refine` 400s an empty
 * one, so callers always pass a real change.
 */
export async function updateWorkspaceTodo(
  projectId: string,
  id: string,
  patch: UpdateTodoInput,
): Promise<UpdateTodoResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].todos[':id'].$patch({
      param: { projectId, id: encodeURIComponent(id) },
      json: patch,
    }),
    `/todos/${encodeURIComponent(id)}`,
  )
}

/** "Pick this one" (spec 010): the winner rests at `review` for the gate; the losers are
 *  cancelled if alive, archived, and their worktrees + branches removed. 409 while the picked
 *  variant is still active — the server's words come back verbatim in the ApiError. */
export async function pickVariant(groupId: string, runId: string): Promise<PickVariantResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].groups[':groupId'].pick.$post({
      param: { projectId: queryScope(), groupId: encodeURIComponent(groupId) },
      json: { runId },
    }),
    `/groups/${encodeURIComponent(groupId)}/pick`,
  )
}

/** Hand the session off to a real terminal (spec 003), in the run's worktree when it still
 *  exists. On 409 the ApiError's `command` carries the manual `cd … && <resume>` to copy. */
export async function openRunInCli(id: string): Promise<OpenInCliResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['open-in-cli'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/open-in-cli'),
  )
}

/** The local editors / file-manager / terminal this machine can open a worktree in (#open-in).
 *  Empty in hosted mode (CEZ_REMOTE). */
export async function getOpenTargets(opts?: ReadOptions): Promise<OpenTargetsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId']['open-targets'].$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/open-targets',
  )
}

/** Open the ACTIVE PROJECT's own folder in the chosen local app (Settings → "Project folder").
 *  No path travels: the server opens the scoped project's registered root. 400 for an app this
 *  machine does not have or a `cli:` handoff, 409 in hosted mode or when the launch failed. */
export async function openProjectIn(target: string): Promise<OpenProjectInResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId']['open-in'].$post({
      param: { projectId: queryScope() },
      json: { target },
    }),
    '/open-in',
  )
}

/** Open the run's worktree in the chosen local app. 409 with `path` when it could not launch. */
export async function openRunIn(
  id: string,
  target: string,
): Promise<{ opened: boolean; path: string }> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['open-in'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { target },
    }),
    runPath(id, '/open-in'),
  )
}

/** Diff pane "open in default app" (#365, LOCAL MODE ONLY): opens one worktree file with the
 *  OS's default handler for its type — not the file manager, a specific file. 409 (server's own
 *  words) in hosted mode, for a path outside the worktree, or when no app could be launched. */
export async function openRunFileInApp(
  id: string,
  path: string,
): Promise<{ opened: boolean; path: string }> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['open-in'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { target: 'default', path },
    }),
    runPath(id, '/open-in'),
  )
}

/** `git add -A && git commit` in the run's worktree (R5). Every predictable git failure —
 *  clean tree, failing hook, missing identity — is a 409 whose ApiError speaks git's words. */
export async function commitRun(id: string, message: string): Promise<GitCommitResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].git.commit.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { message },
    }),
    runPath(id, '/git/commit'),
  )
}

/** Push the worktree's branch, setting upstream when it has none (R5). No remote, detached
 *  HEAD and rejected pushes all come back as 409 + reason. */
export async function pushRun(id: string): Promise<GitPushResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].git.push.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/git/push'),
  )
}

/** Deliver text and/or pasted screenshots into a run's live session. 409 once it has closed. */
export async function sendMessage(id: string, message: MessageInput): Promise<MessageResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].messages.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { text: message.text ?? '', images: message.images ?? [] },
    }),
    runPath(id, '/messages'),
  )
}

/** Replace a stacked message on a still-queued run (#472). 404 unknown run/message,
 *  409 once the run has started. */
export async function editQueuedMessage(
  id: string,
  msgId: string,
  message: MessageInput,
): Promise<EditQueuedMessageResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['queued-messages'][':msgId'].$patch({
      param: { projectId: queryScope(), id: encodeURIComponent(id), msgId: encodeURIComponent(msgId) },
      json: message,
    }),
    runPath(id, `/queued-messages/${encodeURIComponent(msgId)}`),
  )
}

/** Drop a stacked message from a still-queued run (#472). */
export async function removeQueuedMessage(
  id: string,
  msgId: string,
): Promise<RemoveQueuedMessageResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['queued-messages'][':msgId'].$delete({
      param: { projectId: queryScope(), id: encodeURIComponent(id), msgId: encodeURIComponent(msgId) },
    }),
    runPath(id, `/queued-messages/${encodeURIComponent(msgId)}`),
  )
}

/** Repo-view branch action (R5): switch to an existing branch, or create one (from `from` or
 *  HEAD) and switch. Invalid names, unknown start points and dirty-tree checkout conflicts
 *  all come back as 409 whose ApiError carries git's own reason. */
export async function createRepoBranch(input: { name: string; from?: string }): Promise<RepoBranchResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.branch.$post({
      param: { projectId: queryScope() },
      json: input,
    }),
    '/repo/branch',
  )
}

// ---- plan mode (spec 008) -------------------------------------------------------------------

/** Chain-from-prompt: the planner proposes 1–5 steps for the task. Degraded answers come back
 *  as a one-step plan with `fallback: true`, never as an error — only transport/validation fail. */
export async function postPlan(task: string): Promise<PlanResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].plan.$post({
      param: { projectId: queryScope() },
      json: { task },
    }),
    '/plan',
  )
}

// ---- GitHub automations (#694) ---------------------------------------------------------------
//
// Project-scoped, like the runs family: the definitions, their state and the log are per-project
// files. The one exception is `getAutomationCheck` — a manual check lives in the server's memory
// under an id the POST handed back, and its route reads no project, so it has no scoped spelling.

/** Every automation with its runtime state, latest log row and tallies, plus the forge's
 *  availability and the scheduler summary — one read, the whole page. */
export async function getAutomations(opts?: ReadOptions): Promise<AutomationsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/automations',
  )
}

/** Create a definition. Always created PAUSED unless `enable` asks for a current-time baseline. */
export async function createAutomation(input: CreateAutomationInput): Promise<AutomationResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations.$post({
      param: { projectId: queryScope() },
      json: input,
    }),
    '/automations',
  )
}

/** Edit a definition. `expectedRevision` is the one the editor read — a stale one answers 409
 *  rather than overwriting an edit made elsewhere. */
export async function updateAutomation(
  id: string,
  input: UpdateAutomationInput,
): Promise<AutomationResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations[':id'].$put({
      // `hc` does not percent-encode a path param, so ids are pre-encoded at every call site.
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: input,
    }),
    `/automations/${encodeURIComponent(id)}`,
  )
}

/** Enable (from a current-time baseline — existing records never launch) or pause. Two routes,
 *  because they are two acts: only one of them establishes a baseline. */
export async function setAutomationEnabled(id: string, enabled: boolean): Promise<AutomationResponse> {
  const param = { projectId: queryScope(), id: encodeURIComponent(id) }
  const label = `/automations/${encodeURIComponent(id)}/${enabled ? 'enable' : 'pause'}`
  return unwrap(
    enabled
      ? await cez.api.v1.p[':projectId'].automations[':id'].enable.$post({ param })
      : await cez.api.v1.p[':projectId'].automations[':id'].pause.$post({ param }),
    label,
  )
}

/** Start a manual check (202) — `preview` counts matches and launches nothing, `execute` runs
 *  the poll for real. Poll `getAutomationCheck` with the returned id. */
export async function checkAutomation(
  id: string,
  mode: 'preview' | 'execute',
): Promise<AutomationCheckQueuedResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations[':id'].check.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { mode },
    }),
    `/automations/${encodeURIComponent(id)}/check`,
  )
}

/** One manual check's progress. Workspace-level: the check registry is the server's, not a
 *  project's — the id is the whole address. */
export async function getAutomationCheck(id: string, opts?: ReadOptions): Promise<AutomationCheck> {
  return unwrap(
    await cez.api.v1['automation-checks'][':checkId'].$get(
      { param: { checkId: encodeURIComponent(id) } },
      init(opts),
    ),
    `/automation-checks/${encodeURIComponent(id)}`,
  )
}

/** One automation's execution log — newest first, capped server-side at 100 rows. */
export async function getAutomationLog(
  id: string,
  opts?: ReadOptions,
): Promise<AutomationLogResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId']['automation-log'].$get(
      { param: { projectId: queryScope() }, query: { automationId: id } },
      init(opts),
    ),
    `/automation-log?automationId=${encodeURIComponent(id)}`,
  )
}

/** Save an approved plan as a reusable chain. A 409 carries `exists: true` on the ApiError —
 *  ask the user, then retry with `overwrite: true`. */
export async function createWorkflow(input: SaveWorkflowInput): Promise<SaveWorkflowResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].workflows.$post({
      param: { projectId: queryScope() },
      json: input,
    }),
    '/workflows',
  )
}

/** Import support for the builder (spec 012): the server parses + validates pasted workflow
 *  YAML (either form) and answers the normalized definition. */
export async function parseWorkflow(yaml: string): Promise<ParsedWorkflow> {
  return unwrap(
    await cez.api.v1.p[':projectId'].workflows.parse.$post({
      param: { projectId: queryScope() },
      json: { yaml },
    }),
    '/workflows/parse',
  )
}

/** Delete a saved workflow file (spec 012 follow-up). Built-ins answer 400 — they have no
 *  file and always come back. */
export async function deleteWorkflow(name: string): Promise<DeleteWorkflowResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].workflows[':name'].$delete({
      param: { projectId: queryScope(), name: encodeURIComponent(name) },
    }),
    `/workflows/${encodeURIComponent(name)}`,
  )
}

// ---- prefs ---------------------------------------------------------------------------------

/** Merges server-side (the stored object spread under the patch) and answers the merged state. */
export async function putUiState(patch: UiState): Promise<UiState> {
  return unwrap(
    await cez.api.v1.p[':projectId']['ui-state'].$put({
      param: { projectId: queryScope() },
      json: patch,
    }),
    '/ui-state',
  )
}

/** The cross-project GUI state (`~/.cezar/ui-state.json`, step 2.7). Workspace-level:
 *  `apiPath` never prefixes `/api/workspace/*`. */
export async function getWorkspaceUiState(opts?: ReadOptions): Promise<WorkspaceUiState> {
  return unwrap(await cez.api.v1.workspace['ui-state'].$get({}, init(opts)), '/workspace/ui-state')
}

/** Shallow top-level merge server-side, same as its per-repo twin — send whole top-level
 *  objects (`{ sidebar: {...} }`), never a nested leaf alone. Answers the merged state. */
export async function putWorkspaceUiState(
  patch: SetWorkspaceUiStateInput,
  opts: { keepalive?: boolean } = {},
): Promise<WorkspaceUiState> {
  return unwrap(
    await cez.api.v1.workspace['ui-state'].$put(
      { json: patch },
      { init: { keepalive: opts.keepalive } },
    ),
    '/workspace/ui-state',
  )
}

/**
 * The global settings slice of `~/.cezar/config.json` (step 2.7) — Settings → Resources, (step 4.4)
 * the checkout-root field, and the agent defaults.
 *
 * `agentDefaults` is materialized HERE rather than guarded at each read site, for the same reason
 * the agent-accounts collections are: during development the cockpit and the server can be
 * different versions (Vite serves this bundle while `dist/` or another process serves the API), and
 * an older server answering without the key crashed the accounts page on `.runner`. One boundary,
 * one place a missing key becomes the empty answer it means.
 */
export async function getWorkspaceConfig(opts?: ReadOptions): Promise<WorkspaceConfigResponse> {
  const answer = await unwrap(
    await cez.api.v1.workspace.config.$get({}, init(opts)),
    '/workspace/config',
  )
  return {
    ...answer,
    agentDefaults: answer.agentDefaults ?? {},
    // Same version-skew floor, one spec later: a server without `projectDefaults` has no machine
    // tier, and all-null is what that means (`.ai/specs/2026-08-21-one-settings-area.md`).
    projectDefaults: answer.projectDefaults ?? {
      systemPrompt: null,
      liveTitleUpdates: null,
      reviewGate: null,
      stepBudget: null,
    },
  }
}

/**
 * Every agent account on this machine (spec 2026-07-29-agent-profiles) — the discovered defaults
 * plus any extra config dirs. Workspace-level, so never scope-prefixed. Hosted mode answers
 * `{editable: false, profiles: [], …}` rather than leaking host paths.
 *
 * The collections are filled in HERE rather than guarded at each of the ~5 read sites. During
 * development the cockpit and the server can be different versions (Vite serves this bundle while
 * `dist/` or another process serves the API), and an older server answering without `files` or
 * `selections` crashed the accounts pane on `.map` of undefined. Normalizing at the boundary — the
 * job this module already does for provider status — means every consumer can trust the shape, and
 * the next additive field is one line here instead of a hunt for missing `??`s.
 */
/**
 * What each agent account is doing right now (`.ai/specs/2026-08-16-agent-account-usage-routing.md`,
 * `CEZ_ACCOUNT_USAGE=1`). Workspace-level, so never scope-prefixed.
 *
 * The flag-off answer is `{enabled: false, accounts: []}` — a 200, not a 404, following the notes
 * family. `enabled` is what separates "the feature is off" from "you have no accounts", which are
 * the same empty list and completely different empty states.
 *
 * Normalized here for the same version-skew reason `getAgentProfiles` gives: an older server
 * answering without `accounts` must not crash the panel on `.map` of undefined.
 */
export async function getAccountUsage(opts?: ReadOptions): Promise<AccountUsageResponse> {
  const answer = await unwrap(
    await cez.api.v1.workspace['agent-accounts'].usage.$get({}, init(opts)),
    '/workspace/agent-accounts/usage',
  )
  return { enabled: answer.enabled ?? false, accounts: answer.accounts ?? [] }
}

export async function getAgentProfiles(opts?: ReadOptions): Promise<AgentProfilesResponse> {
  const answer = await unwrap(
    await cez.api.v1.workspace['agent-profiles'].$get({}, init(opts)),
    '/workspace/agent-profiles',
  )
  return {
    ...answer,
    profileCapableProviders: answer.profileCapableProviders ?? [],
    selections: answer.selections ?? {},
    defaults: answer.defaults ?? {},
    profiles: (answer.profiles ?? []).map((profile) => ({ ...profile, files: profile.files ?? [] })),
  }
}

/** Register an extra config dir as an account. The id is allocated server-side from the label. */
export async function createAgentProfile(
  input: CreateAgentProfileInput,
): Promise<AgentProfileResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'].$post({ json: input }),
    '/workspace/agent-profiles',
  )
}

/** The Claude logins that exist on this machine (`GET …/agent-profiles/discovered`, spec
 *  `.ai/specs/2026-08-14-claude-subscription-autodetect.md`) — what lets "Add account" offer a
 *  second subscription instead of asking for its path. A READ: adding one is still
 *  `createAgentProfile` with the dir it names. */
export async function getDiscoveredAgentAccounts(
  opts?: ReadOptions,
): Promise<DiscoveredAgentAccountsResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'].discovered.$get({}, init(opts)),
    '/workspace/agent-profiles/discovered',
  )
}

/** One account's auth state, probed for real (spec 2026-07-29-agent-profiles). Off the listing on
 *  purpose: a probe shells out to an agent CLI, so the pane paints first and fills rows in as these
 *  land. `refresh` drops the server's cached answer for this account and re-probes. */
export async function getAgentAccountStatus(
  routeId: string,
  opts?: ReadOptions & { refresh?: boolean },
): Promise<AgentAccountStatusResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].status.$get(
      {
        param: { id: encodeURIComponent(routeId) },
        query: opts?.refresh ? { refresh: '1' } : {},
      },
      init(opts),
    ),
    `/workspace/agent-profiles/${encodeURIComponent(routeId)}/status`,
  )
}

/** Who an account is signed in as (spec 2026-07-29-agent-profiles). Fetched only when the user
 *  asks for it — it is deliberately NOT part of the listing, so "hidden by default" means the data
 *  is absent rather than merely unrendered. Address discovered accounts via `agentAccountRouteId`. */
export async function getAgentAccountDetails(
  routeId: string,
  opts?: ReadOptions,
): Promise<AgentAccountDetailsResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].details.$get(
      { param: { id: encodeURIComponent(routeId) } },
      init(opts),
    ),
    `/workspace/agent-profiles/${encodeURIComponent(routeId)}/details`,
  )
}

/** Open one of an account's own config files — or its folder — in a local app. `file` is a catalog
 *  id (or `folder`); this never sends a path, so the route has no traversal surface. */
export async function openAgentAccountFile(
  routeId: string,
  input: OpenAgentAccountFileInput,
): Promise<OpenAgentAccountFileResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].open.$post({
      param: { id: encodeURIComponent(routeId) },
      json: input,
    }),
    `/workspace/agent-profiles/${encodeURIComponent(routeId)}/open`,
  )
}

/** Point one project's provider at an account. `profileId: null` clears it back to the
 *  discovered account. Lives on the accounts family, not `PATCH /projects`, because the selection
 *  is stored beside the accounts it names. */
export async function selectAgentProfile(
  input: SelectAgentProfileInput,
): Promise<AgentProfileSelectionsResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'].selection.$put({ json: input }),
    '/workspace/agent-profiles/selection',
  )
}

/** Rename an account or repoint its folder. Partial — send only what changed. */
export async function updateAgentProfile(
  id: string,
  input: UpdateAgentProfileInput,
): Promise<AgentProfileResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].$patch({
      param: { id: encodeURIComponent(id) },
      json: input,
    }),
    `/workspace/agent-profiles/${encodeURIComponent(id)}`,
  )
}

/** Deregister an account. The folder is never touched, and projects using it fall back to the
 *  discovered default (the server scrubs their references in the same write). */
export async function removeAgentProfile(id: string): Promise<RemoveAgentProfileResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].$delete({
      param: { id: encodeURIComponent(id) },
    }),
    `/workspace/agent-profiles/${encodeURIComponent(id)}`,
  )
}

/** Partial update — absent keys stay untouched; answers the merged config. A `projectsDir`
 *  the server cannot write to comes back as a 400 `ApiError` whose message is the reason,
 *  which is exactly what the Projects pane renders inline (step 4.4). */
export async function putWorkspaceConfig(
  patch: SetWorkspaceConfigInput,
): Promise<WorkspaceConfigResponse> {
  const answer = await unwrap(
    await cez.api.v1.workspace.config.$put({ json: patch }),
    '/workspace/config',
  )
  return {
    ...answer,
    agentDefaults: answer.agentDefaults ?? {},
    projectDefaults: answer.projectDefaults ?? {
      systemPrompt: null,
      liveTitleUpdates: null,
      reviewGate: null,
      stepBudget: null,
    },
  }
}

/** Set/clear the agents' config knobs — base branch, default runner, system prompt, per-runner
 *  model presets (Settings → Agents, R6 1.5). Merged into the raw config.json server-side so
 *  unrelated user keys survive; `null` clears a knob back to its default. */
export async function putConfig(patch: SetConfigInput): Promise<SetConfigResponse> {
  return withConfigTiers(
    await unwrap(
      await cez.api.v1.p[':projectId'].config.$put({
        param: { projectId: queryScope() },
        json: patch,
      }),
      '/config',
    ),
  )
}

/** The worktree management panel (#483): every materialized task worktree with disk usage,
 *  retention state, the total, and the current keep-limit. */
export async function getWorktrees(opts?: ReadOptions): Promise<WorktreesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].worktrees.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/worktrees',
  )
}

/** "Reclaim now": force the retention enforcer to reclaim over-limit finished worktrees
 *  (directory only — branch kept). Returns the reclaimed run ids. Always 200. */
export async function reclaimWorktrees(): Promise<ReclaimWorktreesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].worktrees.reclaim.$post({
      param: { projectId: queryScope() },
      json: {},
    }),
    '/worktrees/reclaim',
  )
}

/** Per-row "Delete" in the worktrees panel: reclaim one run's worktree AND its branch
 *  (the existing spec-006 route). 409 while the run is active. */
export async function removeRunWorktree(id: string): Promise<RemoveWorktreeResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['remove-worktree'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/remove-worktree'),
  )
}

// ---- central-hub scaffold (F1-F4, `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`) -----------
//
// Reads only (see the import-block comment above). With each family's flag unset the server
// answers the D19 flag-off shape — a schema-valid empty payload, never 404 — so these are safe
// to call from a cockpit surface regardless of whether the feature is on.

/** `GET /knowledge` (F1, `CEZ_KB`). Project-scoped. */
export async function getKnowledge(opts?: ReadOptions): Promise<KnowledgeResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].knowledge.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/knowledge',
  )
}

/** `GET /knowledge/search`. `q` omitted searches with an empty query (the facet-only browse case). */
export async function searchKnowledge(
  query: { q?: string; type?: string; tag?: string; status?: string; root?: string; limit?: number; offset?: number } = {},
  opts?: ReadOptions,
): Promise<KnowledgeSearchResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].knowledge.search.$get(
      {
        param: { projectId: queryScope() },
        query: {
          q: query.q,
          type: query.type,
          tag: query.tag,
          status: query.status,
          root: query.root,
          // Numbers, NOT `String(…)`: `queryZodValidator` publishes the schema's OUTPUT as the
          // request type (see `server/validators.ts`), so a `z.coerce.number()` key is typed
          // `number` on the wire and `hc` stringifies it itself.
          limit: query.limit,
          offset: query.offset,
        },
      },
      init(opts),
    ),
    '/knowledge/search',
  )
}

/** `GET /knowledge/documents` (skills-preview parity) — the browseable catalog: every indexed
 *  document, bodyless AND linkless, sorted `updatedAt` desc / `id` tie-break server-side. The
 *  Knowledge page's always-populated list pane loads this once and filters it client-side
 *  (`lib/knowledge.ts`'s `filterKnowledgeDocs`) rather than re-fetching per keystroke. */
export async function getKnowledgeDocuments(opts?: ReadOptions): Promise<KnowledgeDocumentsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].knowledge.documents.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/knowledge/documents',
  )
}

/** `GET /knowledge/proposals` — pending agent write-back proposals awaiting review. */
export async function getKnowledgeProposals(opts?: ReadOptions): Promise<KnowledgeProposalsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].knowledge.proposals.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/knowledge/proposals',
  )
}

/** `GET /knowledge/:id`. `{document: null}` for both "off" and "no such id" — the reader tells
 *  the two apart from `enabled` on `useKnowledge()`, not from this call. */
export async function getKnowledgeDocument(
  id: string,
  opts?: ReadOptions,
): Promise<KnowledgeDocumentResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].knowledge[':id'].$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    '/knowledge/:id',
  )
}

// ---- report triage (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`, "Reports is a
// workspace tab" amendment) -----------------------------------------------------------------
//
// WORKSPACE-SCOPED, single-mount, never mirrored under `/api/v1/p/` (CHANGED 2026-08-19). This
// family used to be `/api/v1/reports`, project-scoped like Knowledge. It could not stay there: a
// knowledge mount is declared in the OPERATOR's `~/.cezar/config.json`, not in any repo, so on
// the deployment that motivated the move every one of 12 registered projects resolved the SAME
// 196 reports — 12 identical queues, each with its own triage store, each able to answer the
// same question differently. Measured, not hypothetical: two stores existed on the box and the
// second one re-decided reports the first had already triaged. One queue, one decision, at
// workspace scope — see `contract/src/reports.ts`'s own doc comment for the full account.
//
// Reports are knowledge documents carrying the reports tag, so the whole family is still gated on
// `capabilities.knowledge`: with `CEZ_KB` unset the GETs answer `enabled: false` with empty
// payloads and the mutators 409. The cockpit hides the surface on that capability rather than
// discovering it from a failed call.

/** `GET /workspace/reports` — the triage queue: pending first, then newest filed. `counts`
 *  always describes the WHOLE set, so a filtered view's badges still say how much there is.
 *  `project` is a MEMBERSHIP filter (`ReportsQuery.project`, matched against a row's `projects`
 *  array), never equality against the row's canonical `project` — a report resolved by several
 *  projects stays visible under every one of them. */
export async function getReports(
  query: { status?: ReportStatus; domain?: string; project?: string; limit?: number; offset?: number } = {},
  opts?: ReadOptions,
): Promise<ReportsResponse> {
  return unwrap(
    await cez.api.v1.workspace.reports.$get(
      {
        query: {
          status: query.status,
          domain: query.domain,
          project: query.project,
          // Numbers, not strings: `reportsQuerySchema` coerces, and Hono types the request from the
          // schema's INPUT side, which for `z.coerce.number()` is the number.
          limit: query.limit,
          offset: query.offset,
        },
      },
      init(opts),
    ),
    '/workspace/reports',
  )
}

/** `GET /workspace/reports/:key` — one report plus its markdown body. */
export async function getReport(key: string, opts?: ReadOptions): Promise<ReportDetailResponse> {
  return unwrap(
    await cez.api.v1.workspace.reports[':key'].$get(
      { param: { key: encodeURIComponent(key) } },
      init(opts),
    ),
    `/workspace/reports/${encodeURIComponent(key)}`,
  )
}

/** `POST /workspace/reports/:key/approve` — mint the todo this report becomes. Idempotent: a
 *  second approve returns the same todo with `alreadyApproved: true` rather than a duplicate. */
export async function approveReport(
  key: string,
  body: { todoProjectId?: string; priority?: 'high' | 'medium' | 'low' } = {},
): Promise<ReportApproveResponse> {
  return unwrap(
    await cez.api.v1.workspace.reports[':key'].approve.$post({
      param: { key: encodeURIComponent(key) },
      json: body,
    }),
    `/workspace/reports/${encodeURIComponent(key)}/approve`,
  )
}

/** `POST /workspace/reports/:key/dismiss`. The reason is required by the server — a dismissal
 *  without one is a report quietly lost — so this signature makes it required too rather than
 *  letting the 400 teach the caller. */
export async function dismissReport(key: string, reason: string): Promise<ReportDismissResponse> {
  return unwrap(
    await cez.api.v1.workspace.reports[':key'].dismiss.$post({
      param: { key: encodeURIComponent(key) },
      json: { reason },
    }),
    `/workspace/reports/${encodeURIComponent(key)}/dismiss`,
  )
}

/** `POST /workspace/reports/:key/reopen` — back to pending. Any todo an earlier approve minted is
 *  NAMED in the response, never deleted: by now it may be started or done. */
export async function reopenReport(key: string): Promise<ReportReopenResponse> {
  return unwrap(
    await cez.api.v1.workspace.reports[':key'].reopen.$post({
      param: { key: encodeURIComponent(key) },
    }),
    `/workspace/reports/${encodeURIComponent(key)}/reopen`,
  )
}

/** `POST /workspace/reports/process-pending` — convert every pending report at once. A POST,
 *  never a GET: it writes, and a side-effecting GET is one a browser or a crawler may replay.
 *  409 unless auto mode is on (`CEZ_REPORTS_AUTO=1`, or `reports.auto` in the project config). */
export async function processPendingReports(): Promise<ReportProcessPendingResponse> {
  return unwrap(
    await cez.api.v1.workspace.reports['process-pending'].$post(),
    '/workspace/reports/process-pending',
  )
}

/** `GET /sources` (F2, `CEZ_SOURCES`). Project-scoped connection list. */
export async function getSources(opts?: ReadOptions): Promise<SourcesListResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].sources.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/sources',
  )
}

/** `GET /sources/providers` — the provider catalog, including an unavailable provider's reason. */
export async function getSourceProviders(opts?: ReadOptions): Promise<SourceProvidersResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].sources.providers.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/sources/providers',
  )
}

export async function getSourceCollections(
  connectionId: string,
  opts?: ReadOptions,
): Promise<SourceCollectionsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].sources[':connectionId'].collections.$get(
      { param: { projectId: queryScope(), connectionId } },
      init(opts),
    ),
    '/sources/:connectionId/collections',
  )
}

/** Mirrored document metadata for one connection, no bodies. */
export async function getSourceDocuments(
  connectionId: string,
  opts?: ReadOptions,
): Promise<SourceDocumentsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].sources[':connectionId'].documents.$get(
      { param: { projectId: queryScope(), connectionId } },
      init(opts),
    ),
    '/sources/:connectionId/documents',
  )
}

/** One mirrored document, with its body. */
export async function getSourceDocument(
  connectionId: string,
  docId: string,
  opts?: ReadOptions,
): Promise<SourceDocumentResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].sources[':connectionId'].documents[':docId'].$get(
      { param: { projectId: queryScope(), connectionId, docId } },
      init(opts),
    ),
    '/sources/:connectionId/documents/:docId',
  )
}

export async function getSourceComments(
  connectionId: string,
  opts?: ReadOptions,
): Promise<SourceCommentsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].sources[':connectionId'].comments.$get(
      { param: { projectId: queryScope(), connectionId } },
      init(opts),
    ),
    '/sources/:connectionId/comments',
  )
}

export async function getSourceLog(
  connectionId: string,
  query: { cursor?: string; limit?: number } = {},
  opts?: ReadOptions,
): Promise<SourceLogResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].sources[':connectionId'].log.$get(
      {
        param: { projectId: queryScope(), connectionId },
        query: {
          cursor: query.cursor,
          limit: query.limit,
        },
      },
      init(opts),
    ),
    '/sources/:connectionId/log',
  )
}

/** `GET /workspace/notes` (F3 feature B, `CEZ_NOTES`). Workspace-level, never project-scoped
 *  (D14 — a note has not yet been assigned to a project). */
export async function getWorkspaceNotes(
  query: { status?: 'raw' | 'processing' | 'processed' | 'all'; projects?: string; limit?: number } = {},
  opts?: ReadOptions,
): Promise<NotesListResponse> {
  return unwrap(
    await cez.api.v1.workspace.notes.$get(
      {
        query: {
          status: query.status,
          projects: query.projects,
          limit: query.limit,
        },
      },
      init(opts),
    ),
    '/workspace/notes',
  )
}

export async function getWorkspaceNote(noteId: string, opts?: ReadOptions): Promise<NoteResponse> {
  return unwrap(
    await cez.api.v1.workspace.notes[':noteId'].$get({ param: { noteId } }, init(opts)),
    '/workspace/notes/:noteId',
  )
}

/** `POST /workspace/notes` — THE single write path for a note, whatever typed it. */
export async function createWorkspaceNote(input: CreateNoteInput): Promise<NoteResponse> {
  return unwrap(await cez.api.v1.workspace.notes.$post({ json: input }), '/workspace/notes')
}

export async function updateWorkspaceNote(noteId: string, input: UpdateNoteInput): Promise<NoteResponse> {
  return unwrap(
    await cez.api.v1.workspace.notes[':noteId'].$patch({ param: { noteId }, json: input }),
    '/workspace/notes/:noteId',
  )
}

export async function deleteWorkspaceNote(noteId: string): Promise<NoteRemovedResponse> {
  return unwrap(
    await cez.api.v1.workspace.notes[':noteId'].$delete({ param: { noteId } }),
    '/workspace/notes/:noteId',
  )
}

/** `POST /workspace/notes/:noteId/process` — 202. Answers the note marked `processing`; the pass
 *  itself lands later, over the workspace stream and on the next read. */
export async function processWorkspaceNote(noteId: string): Promise<ProcessNoteResponse> {
  return unwrap(
    await cez.api.v1.workspace.notes[':noteId'].process.$post({ param: { noteId } }),
    '/workspace/notes/:noteId/process',
  )
}

/** Partial success is a 200 with `created` and `rejected` side by side — read both, never just
 *  the status. Two of three proposals starting is the normal case, not an error. */
export async function approveWorkspaceNote(
  noteId: string,
  input: ApproveNoteInput,
): Promise<ApproveNoteResponse> {
  return unwrap(
    await cez.api.v1.workspace.notes[':noteId'].approve.$post({ param: { noteId }, json: input }),
    '/workspace/notes/:noteId/approve',
  )
}

export async function rejectWorkspaceNote(
  noteId: string,
  input: RejectNoteInput,
): Promise<NoteResponse> {
  return unwrap(
    await cez.api.v1.workspace.notes[':noteId'].reject.$post({ param: { noteId }, json: input }),
    '/workspace/notes/:noteId/reject',
  )
}

/** `GET /workspace/runs` (F3 feature A, `CEZ_WORKSPACE_VIEWS`) — the cross-project aggregate.
 *  Also reports the flag-off shape under `CEZ_SINGLE_PROJECT=1`, same as its own flag being off. */
export async function getWorkspaceRuns(
  query: { projects?: string; view?: 'active' | 'archived'; limit?: number } = {},
  opts?: ReadOptions,
): Promise<WorkspaceRunsResponse> {
  return unwrap(
    await cez.api.v1.workspace.runs.$get(
      {
        query: {
          projects: query.projects,
          view: query.view,
          limit: query.limit,
        },
      },
      init(opts),
    ),
    '/workspace/runs',
  )
}

/**
 * `GET /workspace/todos` — every filed-but-unstarted task, across every project, in one list.
 *
 * **Ungated on purpose**, unlike its `getWorkspaceRuns` neighbour above. `CEZ_FOLLOWUPS` /
 * `CEZ_WORKSPACE_VIEWS` are both **off on a default install** (measured on the owner's own
 * cockpit), so a capability check here would hide filed work on exactly the machines that have
 * nowhere else to see it — the Inbox is gated on `CEZ_FOLLOWUPS` too. The flag gates whether
 * AGENTS are asked to leave follow-ups; it does not gate reading what exists.
 *
 * **CORRECTED 2026-08-16.** This said the ungating existed because "the composer's All / Auto
 * submit writes through these same todo stores" (D7a of
 * `.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`). That fan-out is deleted — the
 * composer starts one cross-project run instead (`startWorkspaceRun`) and files no todos at all.
 * The ungating stands on its own reason, above: a default install has no other surface for a
 * filed todo, whatever wrote it.
 */
/**
 * One partition's page of the Filed board (`.ai/specs/2026-08-25-split-active-backlog-tables.md`).
 * **Omit it entirely and the request carries no query at all** — the legacy path, whose payload is
 * `BACKWARD_COMPATIBILITY.md` §2 protected and which the Archived table still reads.
 */
export interface WorkspaceTodosParams {
  partition?: FiledPartition
  sort?: FiledSortColumn
  dir?: FiledSortDir
  /** The page's Active/Archived tab. */
  view?: FiledViewValue
  limit?: number
  status?: readonly string[]
  priority?: readonly string[]
  q?: string
}

/**
 * Params → the `hc` query object, dropping every absent key so a partitionless call sends a bare
 * URL rather than `?partition=&sort=` — which is what keeps the legacy path legacy.
 *
 * Typed as the schema's OUTPUT (`limit` a number, the facets arrays) rather than as the wire
 * strings, because `queryZodValidator` publishes the output as the route's REQUEST type — a known
 * property of that helper, documented in `server/validators.ts`: Hono declares a validator's
 * request parameter as a conditional type, which is not an inference site, so the request falls
 * back to the schema's output. `hc` stringifies through `URLSearchParams` on the way out and the
 * server parses strings on the way in, so the wire is unaffected either way.
 */
function toWorkspaceTodosQuery(params: WorkspaceTodosParams | undefined): WorkspaceTodosQuery {
  if (params === undefined) return {}
  return {
    ...(params.partition !== undefined ? { partition: params.partition } : {}),
    ...(params.sort !== undefined ? { sort: params.sort } : {}),
    ...(params.dir !== undefined ? { dir: params.dir } : {}),
    ...(params.view !== undefined ? { view: params.view } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.q !== undefined && params.q !== '' ? { q: params.q } : {}),
    ...(params.status !== undefined && params.status.length > 0 ? { status: [...params.status] } : {}),
    ...(params.priority !== undefined && params.priority.length > 0
      ? { priority: [...params.priority] }
      : {}),
  }
}

export async function getWorkspaceTodos(
  params?: WorkspaceTodosParams,
  opts?: ReadOptions,
): Promise<WorkspaceTodosResponse> {
  return unwrap(
    await cez.api.v1.workspace.todos.$get({ query: toWorkspaceTodosQuery(params) }, init(opts)),
    '/workspace/todos',
  )
}

/**
 * `POST /workspace/analytics/events` — the workspace analytics sink
 * (`.ai/specs/2026-08-26-filed-task-detail-page.md`, reused by
 * `.ai/specs/2026-08-25-split-active-backlog-tables.md` D7). Answers `202 {accepted}` and never
 * 404s or 409s, including with `CEZ_ANALYTICS=0`, so the caller has nothing to branch on. See
 * `lib/analytics.ts`, which is the only thing that should call this: events are buffered and
 * batched there, never posted per action.
 */
export async function postAnalytics(input: AnalyticsEventsRequest): Promise<AnalyticsEventsResponse> {
  return unwrap(
    await cez.api.v1.workspace.analytics.events.$post({ json: input }, init()),
    '/workspace/analytics/events',
  )
}

/** `GET /backup` (`.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`) — the backup
 *  overview the cockpit gates its own visibility on (`enabled`). Always answers `200`: with
 *  `CEZ_BACKUP` unset it is `{enabled:false, provider:null, lastRun:null, snapshotCount:0,
 *  includeSummary:null}`, never a 404. No query parameters. */
export async function getWorkspaceBackup(opts?: ReadOptions): Promise<BackupOverviewResponse> {
  return unwrap(await cez.api.v1.backup.$get({}, init(opts)), '/backup')
}

/** `GET /backup/snapshots` — the stored snapshots, newest-first (each carries stored ISO
 *  timestamps only). `200 {snapshots:[]}` when backup is off. */
export async function getWorkspaceBackupSnapshots(opts?: ReadOptions): Promise<BackupSnapshotsResponse> {
  return unwrap(await cez.api.v1.backup.snapshots.$get({}, init(opts)), '/backup/snapshots')
}

/** `POST /backup/run` — a single incremental run of the engine (a no-change run uploads
 *  nothing, N2). `409` when `CEZ_BACKUP` is off, another run is already in flight, or no
 *  provider/key is configured yet — the server's own `{error}` names which. */
export async function runWorkspaceBackup(): Promise<BackupRunResponse> {
  return unwrap(await cez.api.v1.backup.run.$post(), '/backup/run')
}

/** `POST /backup/verify` — checks the encryption key and provider reachability with a sample
 *  round-trip, without touching a snapshot. `409` when backup is off. */
export async function verifyWorkspaceBackup(): Promise<BackupVerifyResponse> {
  return unwrap(await cez.api.v1.backup.verify.$post(), '/backup/verify')
}

/** `POST /backup/gc` — prunes blobs no live snapshot references. `409` when backup is off. */
export async function gcWorkspaceBackup(): Promise<BackupGcResponse> {
  return unwrap(await cez.api.v1.backup.gc.$post(), '/backup/gc')
}

/** `POST /backup/restore` — fail-closed (N6): restoring into a non-empty target without
 *  `force: true` refuses with a `409` whose `{error}` names the refusal ("refusing to
 *  overwrite …"), so a caller can offer that as a second, explicit confirm before retrying with
 *  `force: true`. `409` too when backup is off. */
export async function restoreWorkspaceBackup(input: BackupRestoreInput): Promise<BackupRestoreResponse> {
  return unwrap(await cez.api.v1.backup.restore.$post({ json: input }), '/backup/restore')
}

/** `GET /workspace/git` (`.ai/specs/2026-08-14-cross-project-git-overview.md`, D1) — one row per
 *  registered project: branch, ahead/behind, dirty count, last commit. Also reports the flag-off
 *  shape under `CEZ_SINGLE_PROJECT=1`, same as its own flag being off — matching `getWorkspaceRuns`
 *  above. No query parameters in v1. */
export async function getWorkspaceGit(opts?: ReadOptions): Promise<WorkspaceGitResponse> {
  return unwrap(await cez.api.v1.workspace.git.$get({}, init(opts)), '/workspace/git')
}

/** `GET /workspace/knowledge/domains` (`.ai/specs/2026-08-14-knowledge-domains-and-changelog.md`,
 *  D1/D5) — `distinct(domain)` over every considered project's knowledge index, unioned: domain,
 *  doc count, contributing projects, and the best-guess index document id when the corpus has one.
 *  Gated on BOTH `capabilities.knowledge` AND `capabilities.workspaceViews` (D6) — off answers 200
 *  with `disabledReason` naming the one that is off, never a generic "disabled". No parameters. */
export async function getWorkspaceKnowledgeDomains(opts?: ReadOptions): Promise<WorkspaceKnowledgeDomainsResponse> {
  return unwrap(await cez.api.v1.workspace.knowledge.domains.$get({}, init(opts)), '/workspace/knowledge/domains')
}

/** `GET /workspace/knowledge/search` (D5) — the cross-project read: peeks a live project context's
 *  `knowledgeStore` where one exists, otherwise opens a standalone one, never builds. Same
 *  `disabledReason` shape as `getWorkspaceKnowledgeDomains` above. */
export async function getWorkspaceKnowledgeSearch(
  query: { q?: string; domain?: string; project?: string; type?: string; status?: string; limit?: number; offset?: number } = {},
  opts?: ReadOptions,
): Promise<WorkspaceKnowledgeSearchResponse> {
  return unwrap(
    await cez.api.v1.workspace.knowledge.search.$get(
      {
        query: {
          q: query.q,
          domain: query.domain,
          project: query.project,
          type: query.type,
          status: query.status,
          limit: query.limit,
          offset: query.offset,
        },
      },
      init(opts),
    ),
    '/workspace/knowledge/search',
  )
}

/** `GET /workspace/knowledge/document` (`.ai/specs/2026-08-17-workspace-knowledge-speed-preview.md`)
 *  — the right-pane preview read behind `/workspace/knowledge`'s search-result and domain-index-doc
 *  links: the ONE workspace-knowledge route that carries a full document body, so a click never has
 *  to leave that page for the per-project one. Same `disabledReason` shape as the family's other
 *  reads; an unknown project or doc id is a 404 the caller (`unwrap`) turns into a rejected promise,
 *  never `{document: null}` — that shape is reserved for the flag-off case. */
export async function getWorkspaceKnowledgeDocument(
  project: string,
  doc: string,
  opts?: ReadOptions,
): Promise<WorkspaceKnowledgeDocumentResponse> {
  return unwrap(
    await cez.api.v1.workspace.knowledge.document.$get({ query: { project, doc } }, init(opts)),
    '/workspace/knowledge/document',
  )
}

/**
 * `POST /workspace/runs` (`.ai/specs/2026-08-15-cross-project-workspace-run.md`) — the composer's
 * Workspace submit: ONE run, not scoped to any project, granted read and write access to every
 * registered project directory. Starts immediately and returns the run, exactly like
 * `createRun` — there is no analysis pass in front of it.
 *
 * **Replaces `fanoutTasks`**, which answered this same submit by filing one todo per project after
 * a ~60 s pass. That whole shape is gone (owner: *"i don't want to have task per each project"*),
 * and with it the pending/result/toast surfaces that existed only to make the wait bearable.
 *
 * Raw `fetch`, not the typed client: the route is landing alongside this change, so `AppType`
 * does not know it yet — the same reason `registerProject` above keeps its own `fetch`.
 * Workspace-level (`WORKSPACE_LEVEL` in `project-scope.ts` already matches `/workspace/`), so it
 * is never `/p/<id>`-prefixed regardless of the active scope. That is the point: the response's
 * own `project` field names where the run landed, and the caller navigates there — the active
 * scope has no say in it.
 */
export async function startWorkspaceRun(
  input: WorkspaceRunStartInput,
): Promise<WorkspaceRunStartResponse> {
  const path = '/workspace/runs'
  const res = await send(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await res.text()
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  const parsed = parseJson(body)
  if (parsed === undefined) {
    throw new ApiError(res.status, `the cezar server answered ${path} with a non-JSON body`)
  }
  return parsed as WorkspaceRunStartResponse
}

/** `GET /workspace/notifications` (F4, `CEZ_NOTIFY`) — the machine-wide outbound transport
 *  registry. Not the per-browser desktop-notification toggle at Settings → Notifications
 *  (`getWorkspaceUiState`/`putWorkspaceUiState` own that one). */
export async function getWorkspaceNotifications(opts?: ReadOptions): Promise<NotificationsResponse> {
  return unwrap(await cez.api.v1.workspace.notifications.$get({}, init(opts)), '/workspace/notifications')
}

export async function getWorkspaceNotificationsLog(
  query: { cursor?: string; limit?: number; transportId?: string; status?: NotificationLogStatus } = {},
  opts?: ReadOptions,
): Promise<NotificationLogResponse> {
  return unwrap(
    await cez.api.v1.workspace.notifications.log.$get(
      {
        query: {
          cursor: query.cursor,
          limit: query.limit,
          transportId: query.transportId,
          status: query.status,
        },
      },
      init(opts),
    ),
    '/workspace/notifications/log',
  )
}

/** `POST /workspace/analytics/events` — the browser-reachable half of the workspace analytics
 *  sink (`.ai/specs/2026-08-26-filed-task-detail-page.md`, `.ai/specs/2026-08-29-spec-tab-review-
 *  feed.md` P3). Workspace-level and single-mount, never `/p/:projectId`-scoped. Every emitter
 *  (`api/analytics.ts`) goes through THIS function rather than its own `fetch`, so it inherits
 *  `credentials: 'include'`, `redirect: 'manual'` and the identity-gate handling every other call
 *  in this module gets — a second transport would report a Cloudflare Access bounce as a plain
 *  network failure instead of a sign-out. */
export async function postAnalyticsEvents(events: AnalyticsEvent[]): Promise<AnalyticsEventsResponse> {
  return unwrap(
    await cez.api.v1.workspace.analytics.events.$post({ json: { events } }),
    '/workspace/analytics/events',
  )
}
