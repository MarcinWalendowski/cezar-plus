import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LEASE_HEARTBEAT_MS = 90_000;

export interface WorktreeLease {
  leaseVersion: 1;
  runId: string;
  ownerBootRoot: string;
  ownerPid: number;
  ownerReleaseId?: string;
  heartbeatAt: string;
}

export function worktreeLeasePath(repoRoot: string, runId: string): string {
  return join(repoRoot, '.ai/cezar/worktree-leases', `${runId}.json`);
}

export async function writeWorktreeLease(
  repoRoot: string,
  runId: string,
  ownerBootRoot: string,
  ownerReleaseId?: string,
): Promise<void> {
  const path = worktreeLeasePath(repoRoot, runId);
  await mkdir(join(repoRoot, '.ai/cezar/worktree-leases'), { recursive: true });
  const lease: WorktreeLease = {
    leaseVersion: 1,
    runId,
    ownerBootRoot,
    ownerPid: process.pid,
    ...(ownerReleaseId ? { ownerReleaseId } : {}),
    heartbeatAt: new Date().toISOString(),
  };
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(lease)}\n`, 'utf8');
  await rename(tmp, path);
}

export async function touchWorktreeLeases(
  repoRoots: readonly string[],
  runId: string,
  ownerBootRoot: string,
  ownerReleaseId?: string,
): Promise<void> {
  await Promise.all(repoRoots.map((root) => writeWorktreeLease(root, runId, ownerBootRoot, ownerReleaseId)));
}

export async function removeWorktreeLeases(repoRoots: readonly string[], runId: string): Promise<void> {
  await Promise.all(repoRoots.map((root) => rm(worktreeLeasePath(root, runId), { force: true }).catch(() => undefined)));
}

export async function readWorktreeLease(repoRoot: string, runId: string): Promise<WorktreeLease | undefined> {
  try {
    return JSON.parse(await readFile(worktreeLeasePath(repoRoot, runId), 'utf8')) as WorktreeLease;
  } catch {
    return undefined;
  }
}
