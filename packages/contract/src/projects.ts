import { z } from 'zod';

/**
 * The project-registry family: `GET/POST/PATCH/DELETE /api/v1/projects`, the folder picker
 * (`GET /api/v1/fs/browse`) that feeds it, and the launch-key read.
 *
 * Node-free by construction (see README rule 1) — `zod` and nothing else.
 */

/**
 * One `GET /api/v1/projects` registry entry (multi-project spec, step 1.6).
 *
 * Unlike health's id+name pairs this carries the absolute `root`: the registry routes are
 * same-origin, the CORS-open health route is not, and that difference is the reason the two
 * project shapes are deliberately NOT the same type.
 *
 * Deliberately a CLOSED object even though the server's persistence schema
 * (`src/workspace/config.ts`, `workspaceProjectSchema.passthrough()`) keeps unknown keys in the
 * file: passthrough is a durability promise about `~/.cezar/config.json`, not a promise that the
 * API answers arbitrary keys. Modelling it as a loose object here would also be unprovable — see
 * the note on the index signature in `src/server/contract-parity.workspace.test.ts`.
 */
export const projectListEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Absolute, realpath-normalized repo root. */
  root: z.string(),
  addedAt: z.string(),
  lastOpenedAt: z.string(),
  source: z.enum(['local', 'checkout']),
  /**
   * `not-git` and `no-commits` are both fully usable (degraded single-queue mode); only `missing`
   * blocks.
   *
   * `no-commits` (2026-08-15) is a repo whose `.git` exists with no commit in it. It used to report
   * `ok`, and that was a silent wrong answer: `git worktree add` SUCCEEDS on such a repo and
   * produces an **empty** tree, so the agent works in a directory holding none of the user's files
   * while the cockpit calls the project healthy. Degraded-but-honest is the correct answer, and
   * "Set up git" in the add-project dialog is the repair.
   */
  status: z.enum(['ok', 'missing', 'not-git', 'no-commits']),
  /** Current branch when cheaply available (omitted e.g. on an unborn HEAD). */
  branch: z.string().optional(),
  /** Which forge this project's remote belongs to (#698) — classified server-side from the
   *  remote URL alone. Gates the project group's GitHub nav item; omitted = no forge remote. */
  forge: z.literal('github').optional(),
  /**
   * The remote's web root, `https://github.com/owner/repo`. Rebuilt server-side from the parsed
   * remote rather than passed through, so a remote carrying credentials cannot leak into the
   * cockpit. Omitted when the project has no forge remote.
   *
   * It exists for the cross-project surfaces: a run often knows a PR or issue only by NUMBER, and
   * the global Tasks page has one row per project, so it cannot use any single repo's base the
   * way a project-scoped view can. With this, every reference it shows is a link.
   */
  repoUrl: z.string().optional(),
  /** Per-project cap on concurrently running tasks (spec 2026-07-22). Omitted = inherit the
   *  workspace `resources.maxParallel`; a number pins this project. */
  maxParallel: z.number().optional(),
  /** Which team this project is assigned to (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`,
   *  D2/D5/D8, Phase 5) — metadata for grouping/filtering, never a scope (D5). Lives in
   *  `<CEZ_HOME>/identity/*.json` (`project_teams`), not in this registry entry itself, so it is
   *  omitted for any root not yet claimed by an org. Present once a registration has assigned (or
   *  claimed) a team for this root.
   *
   *  **CORRECTED 2026-08-07 by D13: "omitted entirely under `CEZ_AUTH` unset (no identity store
   *  exists to answer from)" is FALSE.** D13 (phase 9) lets a local user create an org on a
   *  loopback bind with `CEZ_AUTH` still unset; once they have, `GET /api/v1/projects` DOES read
   *  `<CEZ_HOME>/identity/*.json` (`server.ts#withTeams`, gated on `hasOrgScope(principal)`, never
   *  on `resolveAuthProvider`) and populates this field exactly as it would under real auth. The
   *  precondition this field is actually gated on is "does the caller's principal have an org"
   *  (`hasOrgScope`), which `CEZ_AUTH` unset no longer implies — see D13's own `hasOrgScope` seam
   *  in `auth/principal.ts`. It remains true, and is the accurate replacement, that a caller with
   *  no org yet — `CEZ_AUTH` unset with no local org created, or a hosted deployment before
   *  onboarding — sees this field omitted and the identity store untouched. */
  teamId: z.string().optional(),
  /** The team's display name, denormalized onto the entry beside `teamId` — same precedent as
   *  `forge` (a derived fact the server resolves once so every consumer doesn't re-derive it).
   *  Without it the only thing a client could label a filter option with is the raw team id, and
   *  there is no "list teams" route for it to join against (D5 deliberately adds no new URL
   *  segment or scope for teams). Always accompanies `teamId`; omitted exactly when `teamId` is,
   *  plus the unreachable-today case of a `project_teams` row pointing at a deleted team. */
  teamName: z.string().optional(),
  /**
   * Free-form labels grouping CONNECTED repositories — a `storefront` tag on the API, the web
   * app and the design system says those three are one piece of work spread over three repos.
   * The global Tasks page (`/tasks`) filters and groups by them.
   *
   * Omitted rather than `[]` when a project has none, exactly like `maxParallel`: the registry
   * stores nothing for a project nobody has tagged, and an empty array on the wire would make
   * "never tagged" indistinguishable from "tagged, then emptied" for no gain. Normalized
   * server-side (trimmed, deduped case-insensitively, sorted), so a consumer may compare them
   * directly.
   */
  tags: z.array(z.string()).optional(),
});
export type ProjectListEntry = z.infer<typeof projectListEntrySchema>;

/** `GET /api/v1/projects` — the workspace registry. Workspace-level: never 404s, never scoped.
 *  An unreadable workspace degrades to `projects: []` plus the default `projectsDir`, so all
 *  three keys are always present. */
export const projectsResponseSchema = z.object({
  projects: z.array(projectListEntrySchema),
  bootProject: z.string(),
  projectsDir: z.string(),
});
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;

/**
 * `POST /api/v1/projects` (multi-project spec, step 4.2) — what the folder-browser dialog gets
 * back. `error` is present ONLY on the 409 (already registered), where `project` is the EXISTING
 * entry: the dialog navigates to it rather than dead-ending on a duplicate.
 */
export const registerProjectResponseSchema = z.object({
  project: projectListEntrySchema,
  error: z.string().optional(),
});
export type RegisterProjectResponse = z.infer<typeof registerProjectResponseSchema>;

/**
 * `DELETE /api/v1/projects/:projectId` (multi-project spec, step 4.4) — Settings → Projects'
 * per-row Remove. Deregistration ONLY: the server never touches anything under the project root,
 * so this is a registry edit and nothing else. The interesting failures are 409s (the project has
 * running tasks, or it is the project this server booted in), whose `{ error }` the pane shows
 * verbatim.
 */
export const removeProjectResponseSchema = z.object({
  removed: z.literal(true),
  id: z.string(),
});
export type RemoveProjectResponse = z.infer<typeof removeProjectResponseSchema>;

/** `PATCH /api/v1/projects/:projectId` — the updated entry, the same shape `GET /api/v1/projects`
 *  attaches (the handler re-probes `status`/`branch` so one project has one shape). */
export const updateProjectResponseSchema = z.object({
  project: projectListEntrySchema,
});
export type UpdateProjectResponse = z.infer<typeof updateProjectResponseSchema>;

/** Bounds for one tag and for a project's tag list. Named because three places must agree: this
 *  schema, the registry schema that must never `.catch` away a value this accepts
 *  (`workspaceProjectSchema` in the service), and the settings editor that refuses input early. */
export const PROJECT_TAG_MAX_LENGTH = 32;
export const PROJECT_TAGS_MAX = 20;

/**
 * `PATCH /api/v1/projects/:projectId` body — the two per-project registry fields the cockpit
 * edits. Each key is optional and a body may carry either or both: a PATCH names the fields it
 * changes, and an absent key must stay distinguishable from one set to `null` (which CLEARS). A
 * `{ maxParallel }`-only body — every pre-tags client sends exactly that — therefore still means
 * what it always did. An EMPTY body is still refused, as it was before tags existed: a request
 * that names no field is a mistake, and answering 200 to it would report a change that never
 * happened (and cost a full config rewrite to do nothing).
 *
 * - `maxParallel` (spec 2026-07-22-per-project-concurrency): `null` clears the override back to
 *   "inherit the workspace cap"; an integer `1..16` pins it. The bounds mirror
 *   `workspaceProjectSchema` exactly, so a value this schema accepts can never be degraded away
 *   by the next load's `.catch`.
 * - `tags`: the whole list, replaced wholesale — there is no add-one/remove-one spelling,
 *   because the editor always knows the full set and a merge protocol would only add a way for
 *   two tabs to disagree. `null` and `[]` both clear it; the server normalizes before storing.
 *
 * Deliberately NOT where the agent-account selection lives — that is
 * `PUT /api/v1/workspace/agent-profiles/selection`, stored beside the accounts it names.
 *
 * **`maxParallel` relaxed to OPTIONAL, and `teamId` added — both 2026-08-07 (5b/5c/8 scaffold
 * pass, D2/D4, Phase 5c).** Additive, BC-safe in both directions: every existing caller already
 * sends `maxParallel` on every call (nothing that used to be accepted is now rejected — the
 * "widen a request schema, never narrow it" rule), and `teamId` absent means "leave the current
 * team assignment untouched", which is what makes an existing `{maxParallel}`-only PATCH answer
 * byte-identically to before.
 *
 * `teamId`, when present, reassigns this project's team WITHIN its owning org — see
 * `auth/identity-store.ts#updateProjectTeam`'s own doc comment for the exact D4 guard (the org
 * itself can never change through this field; only which team inside it). This is the cheapest
 * correct home for reassignment (Fill unit 3, "team CRUD store+HTTP"): the route already resolves
 * a `Principal` and calls `mayActOnRoot` before writing (`server/server.ts`), so the D4 read-side
 * check for "is this even your org's root" is inherited for free rather than re-decided here.
 * Under `CEZ_AUTH` unset, or for a root with no org claim at all, this field must be REJECTED
 * (400) rather than silently ignored — there is no team to reassign FROM, and silently accepting
 * it would let a caller believe a reassignment happened when nothing was written.
 *
 * **CORRECTED 2026-08-07 by D13: "Under `CEZ_AUTH` unset ... this field must be REJECTED" is
 * FALSE as a blanket rule.** D13 lets a local user create an org with `CEZ_AUTH` still unset
 * (loopback bind); once they have, a `teamId` reassignment SUCCEEDS exactly as it would under
 * real auth (`server.ts`'s handler checks `hasOrgScope(principal)`, never `resolveAuthProvider`).
 * The real precondition — unchanged by D13, and what the sentence above should have said — is "no
 * organization to reassign within": `CEZ_AUTH` unset with no local org created yet, or a hosted
 * deployment before its first org exists, both still 400 here for that reason; `CEZ_AUTH` unset
 * with a local org already claimed does not.
 */
export const updateProjectInputSchema = z
  .object({
    maxParallel: z.number().int().min(1).max(16).nullable().optional(),
    teamId: z.string().min(1).optional(),
    tags: z
      .array(z.string().trim().min(1).max(PROJECT_TAG_MAX_LENGTH))
      .max(PROJECT_TAGS_MAX)
      .nullable()
      .optional(),
  })
  .refine(
    (body) => body.maxParallel !== undefined || body.tags !== undefined || body.teamId !== undefined,
    'specify maxParallel, tags or teamId',
  );
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;

/**
 * `POST /api/v1/projects/checkout` (multi-project spec, step 4.3) — the clone-from-GitHub body.
 * `name` defaults server-side to the repo name; `checkoutId` is the cockpit's own correlation
 * token, echoed on every `checkout-progress` event so two tabs cloning at once never render each
 * other's progress.
 */
export const checkoutProjectInputSchema = z.object({
  url: z.string().trim().min(1).max(512),
  name: z.string().trim().max(128).optional(),
  checkoutId: z.string().trim().max(128).optional(),
  // D15: additive, matching `registerProjectSchema`'s existing optional `teamId`. The onboarding
  // wizard's project step is the caller that passes it; every other caller omits it and sends a
  // byte-identical body to before.
  teamId: z.string().trim().min(1).max(200).optional(),
});
export type CheckoutProjectInput = z.infer<typeof checkoutProjectInputSchema>;

/**
 * `POST /api/v1/projects/blank` (D15) — create an empty project rather than adopting an existing
 * folder or cloning one. `name` is a single path SEGMENT, not a path: the server joins it to the
 * configured `projectsDir` (the same root "Clone from GitHub" writes into), so accepting a path
 * would let the caller choose the parent and bypass the containment check that root exists to
 * enforce. Traversal (`..`), separators and a leading dot are refused rather than normalized.
 */
export const createBlankProjectInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/,
      'name must start with a letter or number and contain only letters, numbers, spaces, dots, dashes or underscores',
    )
    .refine((v) => !v.includes('..'), 'name must not contain ".."'),
  teamId: z.string().trim().min(1).max(200).optional(),
});
export type CreateBlankProjectInput = z.infer<typeof createBlankProjectInputSchema>;

/** One directory in a `GET /api/v1/fs/browse` listing (multi-project spec, step 4.1). `path` is
 *  absolute — same-origin route, like `ProjectListEntry.root`. */
export const fsBrowseDirSchema = z.object({
  name: z.string(),
  path: z.string(),
  /** Has a `.git` entry — drives the "git" badge. A non-repo folder is still selectable. */
  isRepo: z.boolean(),
});
export type FsBrowseDir = z.infer<typeof fsBrowseDirSchema>;

/** `GET /api/v1/fs/browse?path=` — the folder picker's listing. Rooted at the independently
 *  configured browse root, directories only. */
export const fsBrowseResponseSchema = z.object({
  /** The realpath'd directory actually listed — never the spelling asked for, so the breadcrumb
   *  shows where the picker really is. */
  path: z.string(),
  /** `null` AT the browse root: there is no "up" out of it, and the dialog must render no parent
   *  row rather than one that 400s. */
  parent: z.string().nullable(),
  dirs: z.array(fsBrowseDirSchema),
  /** True when the listing was capped server-side — surfaced honestly instead of showing a
   *  silently short list. */
  truncated: z.boolean(),
});
export type FsBrowseResponse = z.infer<typeof fsBrowseResponseSchema>;

/**
 * One candidate project found inside a folder the user is about to add (spec
 * `.ai/specs/2026-08-14-nested-repos-as-projects.md`, widened by
 * `.ai/specs/2026-08-15-import-all-folders-as-projects.md`). A PROPOSAL — nothing here is
 * registered until the dialog posts it to `POST /api/v1/projects` like any other folder.
 *
 * Named `nestedRepo…` from the day it only carried repos. The name is kept deliberately: this is a
 * published package, so renaming the export is a breaking change to buy nothing — `isRepo` is what
 * says which kind of row this is.
 */
export const nestedRepoSchema = z.object({
  /** Absolute repo root. Same-origin route, like `ProjectListEntry.root`. */
  path: z.string(),
  /** Relative to the scanned folder, POSIX-spelled (`chat`, `packages/tool`) — the row's label. */
  relPath: z.string(),
  /** What the project would be NAMED once registered — `basename(path)`. */
  name: z.string(),
  branch: z.string().optional(),
  forge: z.literal('github').optional(),
  /**
   * Has a `.git` entry. `false` is a plain directory offered as a project in its own right — the
   * row the 2026-08-15 spec added, and the one that carries the warning.
   *
   * A non-git project is not a cosmetic downgrade: `workflows/run.ts` runs it **in place, one task
   * at a time**, which costs worktree isolation, parallelism and diff-based review. The dialog says
   * so, which is why the flag is transmitted rather than inferred from `branch` being absent (a
   * perfectly good repo can have no branch to report).
   */
  isRepo: z.boolean(),
  /**
   * Repos only (absent on a folder row). `false` means `.git` exists with **no commit yet** —
   * `git worktree add` then succeeds and produces an EMPTY tree, so the isolation the row promises
   * is not there. Such a row offers the same "Set up git" repair a non-git folder does.
   */
  hasCommits: z.boolean().optional(),
  /** Already in the registry, matched on the realpath the registry stores. The row renders checked
   *  and disabled: a checkbox that cannot change what the button does is a lie about the button. */
  registered: z.boolean(),
});
export type NestedRepo = z.infer<typeof nestedRepoSchema>;

/** `GET /api/v1/projects/scan?path=` — every git repo inside `path` (depth ≤ 3, pruned build dirs,
 *  never descending into a repo) plus every non-git immediate child that does not merely CONTAIN
 *  those repos, capped at 25 rows in total. A read: it never writes the registry. */
export const projectScanResponseSchema = z.object({
  /** The realpath'd folder that was scanned — never the spelling asked for, matching `fs/browse`. */
  root: z.string(),
  /** Whether the scanned folder is ITSELF a repo. The dialog's first row is that folder either way
   *  (a non-git folder is a legitimate project), so this only decides its "git" badge. */
  rootIsRepo: z.boolean(),
  /** Repos first, then folder rows — the cap fills in that order (2026-08-15 spec D3), so a
   *  truncated list keeps the rows with the strongest evidence of being a unit of work. */
  repos: z.array(nestedRepoSchema),
  /** True when the 25-row cap bit, for EITHER kind. Rendered, not just carried: a silently partial
   *  list looks exactly like a folder with nothing else in it. */
  truncated: z.boolean(),
});
export type ProjectScanResponse = z.infer<typeof projectScanResponseSchema>;

/**
 * `GET /api/v1/projects/git-preflight?path=` — what "Set up git" WOULD do to this folder
 * (`.ai/specs/2026-08-15-import-all-folders-as-projects.md` D4/D5). A read: it writes nothing.
 *
 * Rendered, never trusted. `POST /api/v1/projects/git-init` re-runs every one of these checks
 * server-side from the path alone, because a client that could hand back `sensitive: []` would be
 * a client that can decide to commit your `.env`.
 */
export const gitPreflightResponseSchema = z.object({
  /** The realpath'd folder inspected — never the spelling asked for, matching `fs/browse`. */
  path: z.string(),
  /** Already has a `.git` entry. With `hasCommits: false` this is the REPAIR case: the button
   *  skips `git init` and does the commit that makes worktrees produce a non-empty tree. */
  alreadyRepo: z.boolean(),
  /** A commit exists. `alreadyRepo && hasCommits` ⇒ there is nothing for the button to do. */
  hasCommits: z.boolean(),
  /** An ANCESTOR is a git repository and this folder is not it. A NOTE, not a refusal: a workspace
   *  folder that is itself tracked (doctrine files at the top of a directory of checkouts) is a
   *  real and common shape, and every checkout inside it is already a repo inside a repo. */
  insideRepo: z.boolean(),
  /** That ancestor repo already TRACKS files here — the actual refusal. Two repositories over one
   *  set of files means each one's history is a lie about the other. The enclosing repo is never
   *  named in the error: it can sit above the browse root. */
  trackedElsewhere: z.boolean(),
  /** Files that would be committed — sensitive and oversized ones excluded from the count. */
  files: z.number().int(),
  /** Their total size in bytes. Shown so "commit 1,240 files (18 MB)" is a decision, not a leap. */
  bytes: z.number().int(),
  /** Relative POSIX paths that will be written into `.gitignore` INSTEAD of committed — detected
   *  secrets (`.env`, `*.pem`, `id_rsa`, …). Named, never silently dropped. */
  sensitive: z.array(z.string()),
  /** Relative POSIX paths over 10 MB, `path (size)`-spelled. Non-empty ⇒ the POST refuses and
   *  writes nothing at all: auto-ignoring a 40 MB asset decides for the user that it is not part
   *  of their project, and committing it blind puts it in history forever. */
  oversized: z.array(z.string()),
  /** The count walk hit its own ceiling — `files`/`bytes` are a floor, not a total. */
  truncated: z.boolean(),
});
export type GitPreflightResponse = z.infer<typeof gitPreflightResponseSchema>;

/** `POST /api/v1/projects/git-init` body. The path and nothing else — every check is re-run
 *  server-side (D4), so there is deliberately no field a caller could use to skip one. */
export const gitInitRequestSchema = z.object({
  path: z.string().min(1),
});
export type GitInitRequest = z.infer<typeof gitInitRequestSchema>;

/** `POST /api/v1/projects/git-init` — what was actually done. */
export const gitInitResponseSchema = z.object({
  path: z.string(),
  /** The branch the first commit landed on (`main`, unless git refused `-b`). */
  branch: z.string(),
  /** Full SHA of that commit. Present ALWAYS: a response without one would describe exactly the
   *  commitless state this endpoint exists to prevent. */
  commit: z.string(),
  /** How many files the commit contains. `0` is legitimate — an empty folder, or one whose whole
   *  content was excluded — and the commit is still made (`--allow-empty`). */
  files: z.number().int(),
  /** The `.gitignore` lines written on the user's behalf, relative POSIX paths. */
  ignored: z.array(z.string()),
});
export type GitInitResponse = z.infer<typeof gitInitResponseSchema>;

/** `GET /api/v1/launch-key` — the bookmarklet auto-start secret (spec 011). Fetched to COMPARE
 *  against the `?key=` query param and to bake into the `javascript:` links the Settings → Skills
 *  bookmarklet panel generates. The value never renders as text, never logs, and never goes back
 *  into the address bar. */
export const launchKeyResponseSchema = z.object({
  key: z.string(),
});
export type LaunchKeyResponse = z.infer<typeof launchKeyResponseSchema>;
