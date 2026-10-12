import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import type { PrivateIndex } from '../cli';

export const pathsOverlap = (left: string, right: string) =>
  left === right ||
  left.startsWith(`${right}/`) ||
  right.startsWith(`${left}/`);

export async function workingPathStat(root: string, path: string) {
  try {
    return await lstat(join(root, path));
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return null;
    throw error;
  }
}

/** Remove deleted leaf entries exactly; never recursively stage a replacement directory. */
export async function stageWorkingFiles(
  index: PrivateIndex,
  root: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const existing: string[] = [];
  const removed: string[] = [];

  for (const path of paths) {
    signal?.throwIfAborted();
    const stat = await workingPathStat(root, path);

    if (stat?.isFile() || stat?.isSymbolicLink()) existing.push(path);
    else if (!stat || stat.isDirectory()) removed.push(path);
    else throw new Error('Select ordinary changed files.');
  }

  if (removed.length)
    await index.run(
      ['update-index', '--force-remove', '-z', '--stdin'],
      removed.map((path) => `${path}\0`).join(''),
    );
  if (existing.length)
    await index.run(
      ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'],
      existing.map((path) => `:(literal)${path}\0`).join(''),
    );
  signal?.throwIfAborted();
}
