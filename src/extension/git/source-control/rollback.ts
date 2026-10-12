import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { GitCli } from '../cli';
import {
  captureSelection,
  type SelectionSnapshot,
  validateSelection,
} from './selected-changes';
import type { WorkingFile } from './working-changes';
import { pathsOverlap } from './working-paths';

export interface RollbackPlan {
  selection: SelectionSnapshot & { head: string };
  root: string;
  tracked: readonly string[];
  newFiles: readonly { path: string; identity: string | null }[];
}

async function fileIdentity(
  root: string,
  path: string,
): Promise<string | null> {
  const absolute = join(root, path);

  try {
    const stat = await lstat(absolute);
    const hash = createHash('sha256');

    hash.update(JSON.stringify([stat.dev, stat.ino, stat.mode]));
    if (stat.isSymbolicLink()) hash.update(await readlink(absolute));
    else if (stat.isFile()) hash.update(await readFile(absolute));
    else
      throw new Error(
        'Rollback supports ordinary files, not directories or submodules.',
      );

    return hash.digest('hex');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

export async function captureRollback(
  cli: GitCli,
  id: string,
  files: readonly WorkingFile[],
): Promise<RollbackPlan> {
  const selection = await captureSelection(cli, id, files);
  const head = selection.head;

  if (!head)
    throw new Error(
      'Create the repository’s first commit before using Rollback.',
    );
  const root = (await cli.run(id, ['rev-parse', '--show-toplevel'])).trim();
  const trackedPaths = new Set(
    (await cli.run(id, ['ls-tree', '-r', '--name-only', '-z', head])).split(
      '\0',
    ),
  );
  const tracked = selection.paths.filter((path) => trackedPaths.has(path));
  const newFiles = await Promise.all(
    selection.paths
      .filter((path) => !trackedPaths.has(path))
      .map(async (path) => ({
        path,
        identity: await fileIdentity(root, path),
      })),
  );

  await validateSelection(cli, id, selection);

  return { selection: { ...selection, head }, root, tracked, newFiles };
}

const pathspec = (paths: readonly string[]) =>
  paths.map((path) => `:(literal)${path}\0`).join('');

/** Reset only selected paths; retain new copies unless the user separately chooses deletion. */
export async function rollbackSelected(
  cli: GitCli,
  id: string,
  plan: RollbackPlan,
  beforeWrite: () => void = () => undefined,
): Promise<void> {
  await validateSelection(cli, id, plan.selection);
  if (
    plan.newFiles.some(
      (file) =>
        file.identity !== null &&
        plan.tracked.some((path) => pathsOverlap(file.path, path)),
    )
  )
    throw new Error(
      'New files block restoring the original paths. Move or delete those files before using Rollback; they were kept.',
    );
  beforeWrite();
  try {
    if (plan.tracked.length) {
      beforeWrite();
      await cli.runWithInput(
        id,
        [
          'restore',
          `--source=${plan.selection.head}`,
          '--staged',
          '--worktree',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        pathspec(plan.tracked),
      );
    }

    if (plan.newFiles.length) {
      beforeWrite();
      await cli.runWithInput(
        id,
        [
          'reset',
          '--quiet',
          plan.selection.head,
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        pathspec(plan.newFiles.map((file) => file.path)),
      );
    }
  } catch (error) {
    throw new Error(
      'Rollback could not finish. Review the selected files and staging before continuing.',
      { cause: error },
    );
  }
}

/** Never trash a new file that changed while the confirmation or Git operation was running. */
export async function validateNewFiles(plan: RollbackPlan): Promise<void> {
  for (const file of plan.newFiles)
    if ((await fileIdentity(plan.root, file.path)) !== file.identity)
      throw new Error(
        'A new file changed during Rollback. It was kept; review it before deleting it.',
      );
}
