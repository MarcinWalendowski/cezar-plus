import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadWorkflows } from '../workflows/load.ts';

/**
 * The project catalog the triage pass reasons over (P2.2, spec
 * `.ai/specs/2026-08-14-note-to-spec-pipeline.md`). Built on the `AutomationCoordinator` pattern:
 * enumerate the registry, read a cheap file or two per project, and **never materialize a
 * `ProjectContext`**.
 *
 * That last part is the whole reason this class exists rather than a loop over
 * `contexts.context(id)`. Building a context prunes worktrees and calls `manager.recover()`, which
 * RESUMES interrupted agent runs — so a cross-project read that built contexts would restart work
 * in every registered repository as a side effect of someone typing a note. It is invisible at the
 * call site, which is exactly why the guard is structural (`processor.test.ts`) rather than a
 * comment.
 *
 * **Skills are deliberately NOT in the catalog.** Twenty-five projects' skill lists, each with
 * descriptions, is the "prompt explosion" risk the spec names, paid on every pass, to fill an
 * OPTIONAL proposal field. The spec run that follows approval runs inside the target repository
 * with full tool access and can read its skills first-hand — which is both cheaper and better
 * informed than anything a catalog line could say.
 *
 * **Identity signals beyond the registered id, added 2026-08-15 (cezar task #21).** The runtime
 * E2E found routing that mis-targeted silently and confidently: a note named a project by its
 * README title ("widget-service") while the registry knew it only by its id
 * (`cez-e2e-fixture`), and with nothing else to go on the pass matched the note onto a
 * DIFFERENT, actually-registered project instead. `sanitizeProposals` (`./processor.ts`) already
 * refuses to coerce an id it does not recognise — but that guard cannot catch a wrong answer that
 * happens to BE a real id, which is exactly what happened. The fix is upstream of validation: give
 * the pass the same names a human would recognise a project by — its folder name, its
 * `package.json` name, its README title, and its GitHub `owner/repo` — so it can match "the
 * widget-service one" to the right catalog row in the first place. All four are read directly off
 * disk (or off a field the registry already probed), never through a `ProjectContext`.
 */

/** What the pass is told about one candidate project. */
export interface NoteProjectEntry {
  id: string;
  name: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  /** Grouping labels (`storefront`, `infra`). Often the only thing that makes a note's "the api
   *  one" resolvable, so they earn their place in the prompt. */
  tags: string[];
  /** Names only. Enough for the pass to name a workflow the project actually has, and small
   *  enough that twenty-five of them do not dominate the prompt. */
  workflows: string[];
  /** The root directory's basename — what a note calls a project when it is typed from memory of
   *  the folder rather than its registered id. */
  dirName: string;
  /** `package.json`'s `"name"`, when the root has one and it parses. */
  packageName?: string;
  /** The README's first heading, or its first non-empty line when there is no heading in the
   *  first few dozen lines. What a project calls itself in its own docs, which is not always its
   *  registered id, its display name, or its folder. */
  readmeTitle?: string;
  /** `owner/repo`, parsed from `NoteCoordinatorProject.repoUrl` — a field the registry already
   *  probes (`workspace/projects.ts`'s `forgeWebRoot`), so this costs no extra `git` shell-out. */
  remoteSlug?: string;
}

export interface NoteCoordinatorProject {
  id: string;
  root: string;
  name: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  tags?: string[];
  lastOpenedAt?: string;
  /** The remote's web root (`https://github.com/owner/repo`), when the registry has probed one.
   *  `workspace/projects.ts`'s `ProjectListEntry` already carries this — no new I/O to read it. */
  repoUrl?: string;
}

/** A README this large is not worth reading for a one-line title — skip rather than parse. Guards
 *  against a stray large binary someone named `README` as much as a legitimately huge doc. */
const MAX_README_BYTES = 1_000_000;
/** How far into the README to look for a heading before falling back to the first non-empty
 *  line — bounded so a badge-heavy README with no heading in its first screen does not turn into
 *  reading the whole file. */
const README_SCAN_LINES = 40;
/** `package.json`'s `"name"`, capped the same as every other catalog string. */
const MAX_IDENTITY_FIELD_LENGTH = 200;

export interface NoteCoordinatorOptions {
  listProjects: () => Promise<readonly NoteCoordinatorProject[]>;
  warn?: (message: string) => void;
}

/**
 * How many projects one pass considers. A cap rather than "all of them" because the prompt grows
 * linearly with it and a workspace can hold a hundred registered repos. Ordered by `lastOpenedAt`
 * so the projects a person is actually working in are the ones that survive the cut — and
 * `consideredProjects` is persisted on the pass, so "why did it miss that repo?" stays answerable
 * instead of mysterious.
 */
export const MAX_CONSIDERED_PROJECTS = 25;

export class NoteCoordinator {
  constructor(private readonly options: NoteCoordinatorOptions) {}

  /** The projects this pass will consider, newest-opened first, capped. */
  async considered(): Promise<NoteCoordinatorProject[]> {
    let projects: readonly NoteCoordinatorProject[];
    try {
      projects = await this.options.listProjects();
    } catch (error) {
      // An unreadable registry degrades to an empty catalog — the pass then has nothing to target
      // and says so, which is a truthful empty answer rather than a 500 over a capture inbox.
      this.options.warn?.(`Unable to read the project registry: ${describe(error)}`);
      return [];
    }
    return [...projects]
      // A project whose folder is gone cannot host a spec run, so proposing work in it would be
      // proposing something that cannot happen. It is dropped here rather than proposed and then
      // refused at approval, which would waste the pass and read as a bug.
      .filter((project) => project.status !== 'missing')
      .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
      .slice(0, MAX_CONSIDERED_PROJECTS);
  }

  /** The catalog for those projects. One `loadWorkflows` read plus the identity reads below, per
   *  project, in parallel; a project whose workflows (or identity signals) cannot be read still
   *  appears — a missing catalog line must not make the project invisible to the pass. */
  async catalog(projects: readonly NoteCoordinatorProject[]): Promise<NoteProjectEntry[]> {
    return Promise.all(
      projects.map(async (project) => ({
        id: project.id,
        name: project.name || project.id,
        status: project.status,
        tags: project.tags ?? [],
        workflows: await this.workflowNames(project),
        dirName: basename(project.root),
        packageName: await this.packageName(project.root),
        readmeTitle: await this.readmeTitle(project.root),
        remoteSlug: remoteSlugOf(project.repoUrl),
      })),
    );
  }

  private async workflowNames(project: NoteCoordinatorProject): Promise<string[]> {
    try {
      const { workflows } = await loadWorkflows(project.root);
      return workflows.map((workflow) => workflow.name);
    } catch (error) {
      this.options.warn?.(`Unable to read workflows for ${project.id}: ${describe(error)}`);
      return [];
    }
  }

  /** `package.json`'s `"name"` — a direct file read, never a context. Absent, unreadable or
   *  malformed all degrade to `undefined` silently: this is garnish for a prompt line, not a
   *  build input, and a warning for every project without a `package.json` (most non-JS repos)
   *  would be noise on every pass. */
  private async packageName(root: string): Promise<string | undefined> {
    try {
      const raw = await readFile(join(root, 'package.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const name = (parsed as { name?: unknown } | null)?.name;
      return typeof name === 'string' && name.trim()
        ? name.trim().slice(0, MAX_IDENTITY_FIELD_LENGTH)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** The README's title — first heading found within `README_SCAN_LINES`, else the first
   *  non-empty line in that window. Finds the file by listing the directory rather than guessing
   *  one filename, so `Readme.md`, `README.markdown` and plain `README` all resolve the same way
   *  without a growing list of literal names to keep in sync. */
  private async readmeTitle(root: string): Promise<string | undefined> {
    try {
      const entries = await readdir(root);
      const readmeName = entries.find((entry) => entry.toLowerCase().startsWith('readme'));
      if (!readmeName) return undefined;
      const path = join(root, readmeName);
      const stats = await stat(path);
      if (!stats.isFile() || stats.size > MAX_README_BYTES) return undefined;
      const text = await readFile(path, 'utf8');
      return extractReadmeTitle(text);
    } catch {
      return undefined;
    }
  }
}

/** `https://github.com/owner/repo` → `owner/repo`. Parses the ALREADY-BUILT web root rather than
 *  re-deriving it from a raw remote — `repoUrl` was rebuilt by `workspace/projects.ts` from the
 *  parsed remote specifically so it can never carry credentials, and that guarantee is worth
 *  keeping rather than re-parsing the original. Generic over host, not GitHub-specific, so a
 *  future forge needs no change here. */
function remoteSlugOf(repoUrl: string | undefined): string | undefined {
  if (!repoUrl) return undefined;
  const match = /^https?:\/\/[^/]+\/(.+)$/.exec(repoUrl.trim());
  return match?.[1]?.slice(0, MAX_IDENTITY_FIELD_LENGTH);
}

/** The first markdown heading (`#` through `######`) within the first `README_SCAN_LINES` lines,
 *  or the first non-empty line in that window when no heading appears — a badge-heavy README
 *  often has no heading in its opening lines, and "no title found" is a worse answer than "the
 *  first line of prose", which is usually the project's name or tagline. */
function extractReadmeTitle(text: string): string | undefined {
  const lines = text.split('\n').slice(0, README_SCAN_LINES);
  let fallback: string | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) return heading[1]!.trim().slice(0, MAX_IDENTITY_FIELD_LENGTH);
    if (!fallback) fallback = line.slice(0, MAX_IDENTITY_FIELD_LENGTH);
  }
  return fallback;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
