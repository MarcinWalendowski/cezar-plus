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
 */

/** What the pass is told about one candidate project. */
export interface NoteProjectEntry {
  id: string;
  name: string;
  status: 'ok' | 'missing' | 'not-git';
  /** Grouping labels (`storefront`, `infra`). Often the only thing that makes a note's "the api
   *  one" resolvable, so they earn their place in the prompt. */
  tags: string[];
  /** Names only. Enough for the pass to name a workflow the project actually has, and small
   *  enough that twenty-five of them do not dominate the prompt. */
  workflows: string[];
}

export interface NoteCoordinatorProject {
  id: string;
  root: string;
  name: string;
  status: 'ok' | 'missing' | 'not-git';
  tags?: string[];
  lastOpenedAt?: string;
}

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

  /** The catalog for those projects. One `loadWorkflows` read each, in parallel; a project whose
   *  workflows cannot be read still appears, with an empty list — a missing catalog line must not
   *  make the project invisible to the pass. */
  async catalog(projects: readonly NoteCoordinatorProject[]): Promise<NoteProjectEntry[]> {
    return Promise.all(
      projects.map(async (project) => ({
        id: project.id,
        name: project.name || project.id,
        status: project.status,
        tags: project.tags ?? [],
        workflows: await this.workflowNames(project),
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
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
