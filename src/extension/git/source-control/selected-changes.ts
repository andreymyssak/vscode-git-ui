import { createHash } from 'node:crypto';
import { readFile, readlink, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type { CommitMode } from '../../../shared/source-control';
import type { GitCli } from '../cli';
import { requireNoGitOperation } from '../working-tree-state';
import { withCheckedCommitHooks } from './commit-hooks';
import { readWorkingChanges, type WorkingFile } from './working-changes';
import {
  pathsOverlap,
  stageWorkingFiles,
  workingPathStat,
} from './working-paths';

export interface SelectionSnapshot {
  head: string | null;
  paths: readonly string[];
  fingerprint: string;
}

async function headOf(cli: GitCli, id: string): Promise<string | null> {
  try {
    return (await cli.run(id, ['rev-parse', '--verify', 'HEAD'])).trim();
  } catch {
    await cli.run(id, ['symbolic-ref', '--quiet', 'HEAD']);

    return null;
  }
}

async function indexState(cli: GitCli, id: string): Promise<Buffer> {
  // Stage, object, mode and assume-unchanged/skip-worktree flags are semantic;
  // stat-cache refreshes from VS Code do not change the user's staging.
  return cli.runBytes(id, ['ls-files', '--stage', '-v', '-z']);
}

async function requireReady(cli: GitCli, id: string): Promise<void> {
  if (await cli.run(id, ['ls-files', '--unmerged', '-z'])) {
    throw new Error(
      'Resolve conflicts in Source Control before using checked files.',
    );
  }

  await requireNoGitOperation(cli, id, 'committing or stashing checked files');
}

function checkedPaths(paths: readonly string[]): string[] {
  if (!paths.length) throw new Error('Check at least one changed file.');
  for (const path of paths) {
    if (
      !path ||
      isAbsolute(path) ||
      path.includes('\0') ||
      path
        .split(process.platform === 'win32' ? /[\\/]/ : '/')
        .some((part) => part === '..' || part.toLowerCase() === '.git')
    ) {
      throw new Error(
        'Invalid checked file path. Refresh and check the files again.',
      );
    }
  }

  return [...new Set(paths)].sort();
}

function pathspec(paths: readonly string[]): string {
  return checkedPaths(paths)
    .map((path) => `:(literal)${path}\0`)
    .join('');
}

async function fingerprint(
  cli: GitCli,
  id: string,
  head: string | null,
  paths: readonly string[],
): Promise<string> {
  const root = (await cli.run(id, ['rev-parse', '--show-toplevel'])).trim();
  const branch = await cli
    .run(id, ['symbolic-ref', '--quiet', 'HEAD'])
    .catch(() => '');
  const hash = createHash('sha256');

  hash.update(JSON.stringify([id, root, branch, head, paths]));
  hash.update(await indexState(cli, id));
  hash.update(
    JSON.stringify(
      (await readWorkingChanges(cli, id)).filter((file) =>
        [file.path, file.originalPath].some((path) =>
          paths.some((selected) => pathsOverlap(path, selected)),
        ),
      ),
    ),
  );
  for (const path of paths) {
    const absolute = join(root, path);
    const stat = await workingPathStat(root, path);

    if (!stat) {
      hash.update(JSON.stringify([path, 'missing']));
      continue;
    }

    hash.update(JSON.stringify([path, stat.mode]));
    if (stat.isSymbolicLink()) hash.update(await readlink(absolute));
    else if (stat.isFile()) hash.update(await readFile(absolute));
    else if (stat.isDirectory()) hash.update('deleted leaf');
    else throw new Error('Select ordinary changed files.');
  }

  return hash.digest('hex');
}

export async function captureSelection(
  cli: GitCli,
  id: string,
  files: readonly WorkingFile[],
  mode: CommitMode = { kind: 'new' },
): Promise<SelectionSnapshot> {
  await requireReady(cli, id);
  const current = await readWorkingChanges(cli, id);

  for (const file of files) {
    if (
      !current.some(
        (entry) =>
          entry.path === file.path &&
          entry.originalPath === file.originalPath &&
          entry.status === file.status,
      )
    ) {
      throw new Error(
        'Checked files changed. Refresh and check the files again.',
      );
    }
  }

  const paths =
    !files.length && mode.kind === 'amend'
      ? []
      : checkedPaths(files.flatMap((file) => [file.path, file.originalPath]));

  if (
    current.some(
      (entry) =>
        !files.some(
          (file) =>
            file.path === entry.path &&
            file.originalPath === entry.originalPath,
        ) &&
        [entry.path, entry.originalPath].some((path) =>
          paths.some((selected) => pathsOverlap(path, selected)),
        ),
    )
  ) {
    throw new Error(
      'Checked paths overlap unchecked changes. Check all rename or file/directory replacement entries before continuing.',
    );
  }

  const head = await headOf(cli, id);
  const root = (await cli.run(id, ['rev-parse', '--show-toplevel'])).trim();

  for (const path of paths)
    if (
      (await workingPathStat(root, path))?.isDirectory() &&
      !files.some(
        (file) =>
          (file.path === path && file.status.includes('D')) ||
          (file.originalPath === path && file.path !== path),
      )
    )
      throw new Error(
        'Checked directories or submodules are not supported. Select ordinary changed files.',
      );

  if (mode.kind === 'amend' && head !== mode.headSha)
    throw new Error(
      'The last commit changed. Turn Amend off and review the current commit before amending again.',
    );

  return { head, paths, fingerprint: await fingerprint(cli, id, head, paths) };
}

export async function validateSelection(
  cli: GitCli,
  id: string,
  snapshot: SelectionSnapshot,
): Promise<void> {
  if (snapshot.paths.length) checkedPaths(snapshot.paths);
  else if (!snapshot.head) throw new Error('There is no last commit to amend.');
  await requireReady(cli, id);
  const head = await headOf(cli, id);

  if (
    head !== snapshot.head ||
    (await fingerprint(cli, id, head, snapshot.paths)) !== snapshot.fingerprint
  ) {
    throw new Error(
      'Checked files, HEAD, or staging changed. Refresh and review the checked files again.',
    );
  }
}

async function reconcile(
  cli: GitCli,
  id: string,
  paths: readonly string[],
  sha: string,
  previousIndex: Buffer,
): Promise<void> {
  if (
    (await headOf(cli, id)) !== sha ||
    !(await indexState(cli, id)).equals(previousIndex)
  ) {
    throw new Error(
      'HEAD or staging changed during the operation. Review Source Control.',
    );
  }

  if (!paths.length) return;
  await cli.runWithInput(
    id,
    ['reset', '--quiet', sha, '--pathspec-from-file=-', '--pathspec-file-nul'],
    pathspec(paths),
  );
}

export async function commitSelected(
  cli: GitCli,
  id: string,
  snapshot: SelectionSnapshot,
  message: string,
  mode: CommitMode = { kind: 'new' },
): Promise<{ sha: string }> {
  if (!message.trim()) throw new Error('Enter a commit message.');
  if (mode.kind === 'new') checkedPaths(snapshot.paths);
  else if (snapshot.head !== mode.headSha)
    throw new Error(
      'The last commit changed. Review it before amending again.',
    );
  await validateSelection(cli, id, snapshot);
  const expectedParents =
    mode.kind === 'amend'
      ? (await cli.run(id, ['show', '-s', '--format=%P', mode.headSha])).trim()
      : (snapshot.head ?? '');

  return cli.withTemporaryIndex(id, async (index) => {
    await index.run(
      snapshot.head ? ['read-tree', snapshot.head] : ['read-tree', '--empty'],
    );
    const baseTree = (await index.run(['write-tree'])).trim();

    if (snapshot.paths.length)
      await stageWorkingFiles(
        index,
        (await cli.run(id, ['rev-parse', '--show-toplevel'])).trim(),
        snapshot.paths,
      );
    const tree = (await index.run(['write-tree'])).trim();

    if (
      mode.kind === 'new' &&
      snapshot.head &&
      tree ===
        (await cli.run(id, ['rev-parse', `${snapshot.head}^{tree}`])).trim()
    ) {
      throw new Error(
        'The checked working files contain no changes to commit.',
      );
    }

    const branch = await cli
      .run(id, ['symbolic-ref', '--quiet', 'HEAD'])
      .catch(() => '');

    await validateSelection(cli, id, snapshot);
    const previousIndex = await indexState(cli, id);

    const sha = await withCheckedCommitHooks(
      cli,
      id,
      {
        head: snapshot.head,
        branch: branch.trim(),
        base: snapshot.head ?? baseTree,
        paths: snapshot.paths,
      },
      (hooksPath) =>
        index.run([
          '-c',
          `core.hooksPath=${hooksPath}`,
          'commit',
          ...(mode.kind === 'amend' ? ['--amend', '--allow-empty'] : []),
          '-m',
          message,
        ]),
    );

    try {
      const parents = (
        await cli.run(id, ['show', '-s', '--format=%P', sha])
      ).trim();
      const currentBranch = await cli
        .run(id, ['symbolic-ref', '--quiet', 'HEAD'])
        .catch(() => '');

      if (parents !== expectedParents || currentBranch !== branch)
        throw new Error('HEAD or its branch changed during the commit.');
      await reconcile(cli, id, snapshot.paths, sha, previousIndex);
    } catch (error) {
      throw new Error(
        `Commit ${sha} was created, but staging could not be reconciled. Review Source Control; do not repeat the commit.`,
        { cause: error },
      );
    }

    return { sha };
  });
}

export async function stashSelected(
  cli: GitCli,
  id: string,
  snapshot: SelectionSnapshot,
  message: string,
): Promise<{ sha: string }> {
  if (!message.trim()) throw new Error('Enter a stash description.');
  checkedPaths(snapshot.paths);
  await validateSelection(cli, id, snapshot);
  const head = snapshot.head;

  if (!head)
    throw new Error(
      'Create the repository’s first commit before stashing files.',
    );

  return cli.withTemporaryIndex(id, async (index) => {
    await index.run(['read-tree', head]);
    const entries = await cli.run(id, ['ls-files', '--stage', '-z']);
    const selected = new Set(snapshot.paths);
    const selectedEntries = entries
      .split('\0')
      .filter((entry) => selected.has(entry.slice(entry.indexOf('\t') + 1)));
    const zero = '0'.repeat(head.length);

    await index.run(
      ['update-index', '-z', '--index-info'],
      snapshot.paths.map((path) => `0 ${zero}\t${path}\0`).join('') +
        selectedEntries.map((entry) => `${entry}\0`).join(''),
    );
    const indexTree = (await index.run(['write-tree'])).trim();
    const indexCommit = (
      await index.run([
        'commit-tree',
        indexTree,
        '-p',
        head,
        '-m',
        `index: ${message}`,
      ])
    ).trim();
    const basePaths = new Set(
      (await cli.run(id, ['ls-tree', '-r', '--name-only', '-z', head]))
        .split('\0')
        .filter(Boolean),
    );
    const indexedPaths = new Set(
      selectedEntries.map((entry) => entry.slice(entry.indexOf('\t') + 1)),
    );
    const root = (await cli.run(id, ['rev-parse', '--show-toplevel'])).trim();
    const existing: string[] = [];

    for (const path of snapshot.paths) {
      const stat = await workingPathStat(root, path);

      if (stat?.isFile() || stat?.isSymbolicLink()) existing.push(path);
    }

    const tracked = snapshot.paths.filter(
      (path) =>
        indexedPaths.has(path) ||
        (basePaths.has(path) && existing.includes(path)),
    );

    if (tracked.length) await stageWorkingFiles(index, root, tracked);
    const workTree = (await index.run(['write-tree'])).trim();
    const untracked = existing.filter(
      (path) => !basePaths.has(path) && !indexedPaths.has(path),
    );
    const parents = ['-p', head, '-p', indexCommit];

    if (untracked.length) {
      await index.run(['read-tree', '--empty']);
      await index.run(
        ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
        pathspec(untracked),
      );
      const untrackedTree = (await index.run(['write-tree'])).trim();
      const untrackedCommit = (
        await index.run([
          'commit-tree',
          untrackedTree,
          '-m',
          `untracked: ${message}`,
        ])
      ).trim();

      parents.push('-p', untrackedCommit);
    }

    // Normal stash topology: working tree, HEAD, selected index, optional untracked tree.
    // Constructing it explicitly also handles staged deletions and rename source paths,
    // for which stash push can save a stash then fail its own pathspec cleanup.
    const sha = (
      await index.run(['commit-tree', workTree, ...parents, '-m', message])
    ).trim();

    await validateSelection(cli, id, snapshot);
    const previousIndex = await indexState(cli, id);

    await cli.run(id, ['stash', 'store', '-m', message, sha]);
    try {
      await validateSelection(cli, id, snapshot);
      const restore = snapshot.paths.filter((path) => basePaths.has(path));
      const remove = existing.filter((path) => !basePaths.has(path));

      for (const path of remove) await unlink(join(root, path));
      for (const path of remove) {
        for (
          let parent = dirname(path);
          parent !== '.';
          parent = dirname(parent)
        ) {
          try {
            await rmdir(join(root, parent));
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            )
              continue;
            if (
              error instanceof Error &&
              'code' in error &&
              ['ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(String(error.code))
            )
              break;
            throw error;
          }
        }
      }

      for (const path of restore)
        if ((await workingPathStat(root, path))?.isDirectory())
          await rmdir(join(root, path));

      if (restore.length)
        await index.run(
          [
            'restore',
            `--source=${head}`,
            '--worktree',
            '--pathspec-from-file=-',
            '--pathspec-file-nul',
          ],
          pathspec(restore),
        );
      await reconcile(cli, id, snapshot.paths, head, previousIndex);
    } catch (error) {
      throw new Error(
        `Stash ${sha} was saved, but the checked changes could not be fully removed. Review Source Control; do not repeat stashing.`,
        { cause: error },
      );
    }

    return { sha };
  });
}
