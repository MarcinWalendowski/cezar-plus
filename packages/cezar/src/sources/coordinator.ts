import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SourceStore } from './store.ts';

/**
 * Workspace-wide index of "source projects" (F2, W4.4). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` phase "3.2" and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D1..D25.
 *
 * Mirrors `automations/coordinator.ts` exactly in shape: a project is a source project purely
 * because `<root>/.ai/cezar/sources.json` exists, never a git remote, on purpose, since this seam
 * exists to reach a workspace (Notion) that has no such remote at all (spec Q1). Copied in idiom,
 * not shared code: sharing `AutomationCoordinator` would mean widening its protected shape for a
 * domain it was never built for.
 */

export interface SourceProjectSource {
  id: string;
  root: string;
  /** `missing` roots are never opened. */
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
}

export interface SourceCoordinatorOptions {
  listProjects: () => Promise<readonly SourceProjectSource[]>;
  /** The boot project is always a source project, even when the registry is temporarily incomplete. */
  bootProject?: SourceProjectSource;
  warn?: (message: string) => void;
}

export class SourceCoordinator {
  private readonly stores = new Map<string, SourceStore>();
  private readonly roots = new Map<string, string>();

  constructor(private readonly options: SourceCoordinatorOptions) {}

  async refresh(): Promise<void> {
    let projects: readonly SourceProjectSource[];
    try {
      projects = await this.options.listProjects();
    } catch (error) {
      this.options.warn?.(
        `Unable to refresh external source connections: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const allProjects = this.options.bootProject
      ? [this.options.bootProject, ...projects.filter((project) => project.id !== this.options.bootProject!.id)]
      : [...projects];
    const present = new Set(allProjects.map((project) => project.id));
    for (const id of this.stores.keys()) {
      if (!present.has(id)) this.remove(id);
    }
    for (const project of allProjects) {
      if (project.status === 'missing') {
        this.remove(project.id);
        continue;
      }
      this.roots.set(project.id, project.root);
      const definitions = join(project.root, '.ai/cezar/sources.json');
      if (existsSync(definitions)) this.store(project.id, project.root);
    }
  }

  store(projectId: string, root?: string): SourceStore | undefined {
    const existing = this.stores.get(projectId);
    if (existing) return existing;
    const projectRoot = root ?? this.roots.get(projectId);
    if (!projectRoot) return undefined;
    const store = SourceStore.open(join(projectRoot, '.ai/cezar'), {
      warn: this.options.warn,
    });
    this.stores.set(projectId, store);
    this.roots.set(projectId, projectRoot);
    return store;
  }

  /** Projects carrying at least one enabled, non-archived connection: what the scheduler needs
   *  before it bothers building a due set for a project. */
  enabledProjectIds(): string[] {
    return [...this.stores.entries()]
      .filter(([, store]) => store.list().some((connection) => connection.enabled && connection.mode !== 'archived'))
      .map(([id]) => id);
  }

  remove(projectId: string): void {
    this.stores.delete(projectId);
    this.roots.delete(projectId);
  }

  ids(): string[] {
    return [...this.stores.keys()];
  }
}
