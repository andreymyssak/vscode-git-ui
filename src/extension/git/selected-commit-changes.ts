import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FileChange, GitAction } from '../../shared/model';
import type { GitApiAccess } from './api';
import { updateCheckout } from './branch-update-target';
import { rootChanges } from './changes';
import type { GitCli } from './cli';
import { readObjectParents } from './parents';
import { containsRoot } from './paths';
import { readWithCancellation } from './read-cancellation';
import {
  clearSelectedChangeRecovery,
  readSelectedChangeRecovery,
  startSelectedChangeRecovery,
} from './selected-change-recovery';
import {
  GitRequiresSourceControl,
  requireNoGitOperation,
} from './working-tree-state';
import { createWorktreeIdentityResolver } from './worktree-identity';

type SelectedChanges = Extract<
  GitAction,
  { kind: 'cherry-pick-files' | 'revert-files' }
>;

const identity = (file: FileChange) =>
  JSON.stringify([file.status, file.oldPath, file.newPath]);
const pathsOf = (file: FileChange) =>
  [file.oldPath, file.newPath].filter((path): path is string => path !== null);

/** Apply or reverse only the captured comparison's files through the native Git patch API. */
export async function applySelectedCommitChanges(
  access: GitApiAccess,
  cli: Pick<GitCli, 'run'>,
  id: string,
  action: SelectedChanges,
  signal?: AbortSignal,
): Promise<void> {
  const fullIdentity = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;

  if (
    !fullIdentity.test(action.sha) ||
    !fullIdentity.test(action.expectedHeadSha) ||
    (action.parentSha !== null && !fullIdentity.test(action.parentSha)) ||
    !action.expectedBranch ||
    !action.files.length ||
    action.files.length > 400 ||
    new Set(action.files.map(identity)).size !== action.files.length
  )
    throw new Error('Select distinct files from a commit comparison.');
  const reads: Pick<GitCli, 'run'> = {
    run: (repositoryId, args) =>
      readWithCancellation(() => cli.run(repositoryId, args, signal), signal),
  };
  const root = access.repository(id).rootUri;
  let closed = false;
  const subscription = access.api.onDidCloseRepository((repo) => {
    if (repo.rootUri.toString() === root.toString()) closed = true;
  });
  let directory: string | undefined;

  try {
    const parents = await readObjectParents(reads, id, action.sha);

    if (
      action.parentSha === null
        ? parents.length !== 0
        : !parents.includes(action.parentSha)
    )
      throw new Error('Select an actual parent comparison.');
    const comparison = (options: string[], paths: string[] = []) =>
      action.parentSha === null
        ? [
            'diff-tree',
            '--root',
            '--no-commit-id',
            '-r',
            ...options,
            action.sha,
            '--',
            ...paths,
          ]
        : ['diff', ...options, action.parentSha, action.sha, '--', ...paths];
    const options = [
      '--no-ext-diff',
      '--no-textconv',
      '--no-relative',
      '--no-color',
      '-M',
    ];
    const source = rootChanges(
      await reads.run(id, comparison([...options, '--name-status', '-z'])),
    );
    const selected = new Set(action.files.map(identity));

    if (
      source.filter((file) => selected.has(identity(file))).length !==
      selected.size
    )
      throw new Error(
        'The selected files no longer match this commit comparison.',
      );
    const paths = [...new Set(action.files.flatMap(pathsOf))];

    if (
      source.some(
        (file) =>
          !selected.has(identity(file)) &&
          pathsOf(file).some((path) =>
            paths.some(
              (selectedPath) =>
                path === selectedPath || path.startsWith(`${selectedPath}/`),
            ),
          ),
      )
    )
      throw new Error(
        'Selected paths overlap other changes in this commit. Select those related changes together.',
      );
    const pathspecs = paths.map((path) => `:(literal)${path}`);
    const canonical = createWorktreeIdentityResolver();

    const validate = async () => {
      signal?.throwIfAborted();
      if (
        closed ||
        access.repository(id).rootUri.toString() !== root.toString()
      )
        throw new Error('The repository changed. Select the files again.');
      const checkout = await updateCheckout(reads, id);

      if (
        checkout.ref !== `refs/heads/${action.expectedBranch}` ||
        checkout.sha !== action.expectedHeadSha
      )
        throw new Error(
          'The checked-out branch or HEAD changed. Select the files again.',
        );
      await requireNoGitOperation(reads, id, 'applying selected changes');
      const pending = await readSelectedChangeRecovery(reads, id, root.fsPath);

      if (pending) {
        if (pending.head !== checkout.sha || pending.branch !== checkout.ref)
          await clearSelectedChangeRecovery(reads, id, pending);
        else if (
          !(
            await reads.run(id, [
              'status',
              '--porcelain=v1',
              '-z',
              '--untracked-files=all',
              '--ignored=matching',
              '--',
              ...pending.paths.map((path) => `:(literal)${path}`),
            ])
          ).length
        )
          await clearSelectedChangeRecovery(reads, id, pending);
        else
          throw new GitRequiresSourceControl(
            'Finish or abort the previous selected-change attempt in Git UI Changes before applying another patch.',
          );
      }

      if ((await reads.run(id, ['ls-files', '--unmerged', '-z'])).length)
        throw new GitRequiresSourceControl(
          'Resolve existing conflicts in Source Control before applying selected changes.',
        );
      const protectedPaths = new Set(
        await Promise.all(
          (access.worktreeProtectionPaths?.() ?? []).map(canonical),
        ),
      );
      const selectedPaths = await Promise.all(
        paths.map((path) => canonical(join(root.fsPath, path))),
      );

      if (
        selectedPaths.some((path, index) =>
          selectedPaths.some(
            (other, otherIndex) =>
              index !== otherIndex && containsRoot(path, other),
          ),
        )
      )
        throw new Error(
          'Selected changes with overlapping file or folder paths cannot be safely cancelled. Apply the whole commit using Cherry-Pick or Revert.',
        );

      if (selectedPaths.some((path) => protectedPaths.has(path)))
        throw new GitRequiresSourceControl(
          'Save unsaved edits in the selected files before applying changes.',
        );
      if (
        (
          await reads.run(id, [
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
            '--ignored=matching',
            '--ignore-submodules=none',
            '--',
            ...pathspecs,
          ])
        ).length
      )
        throw new GitRequiresSourceControl(
          'Commit or stash local changes in the selected files before applying changes. Unrelated files can remain changed.',
        );
      signal?.throwIfAborted();
    };

    await validate();
    directory = await mkdtemp(join(tmpdir(), 'git-ui-selected-changes-'));
    const patch = join(directory, 'selected.patch');

    // Git writes the original bytes. Native apply takes a filename, not UTF-8 text.
    await reads.run(
      id,
      comparison(
        [
          ...options,
          '--binary',
          '--full-index',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          `--output=${patch}`,
          '-p',
        ],
        pathspecs,
      ),
    );
    if (!(await stat(patch)).size)
      throw new Error('The selected files contain no changes to apply.');
    await validate();
    const checkout = await updateCheckout(reads, id);

    if (
      checkout.ref !== `refs/heads/${action.expectedBranch}` ||
      checkout.sha !== action.expectedHeadSha
    )
      throw new Error(
        'The checked-out branch or HEAD changed. Select the files again.',
      );
    signal?.throwIfAborted();
    if (closed)
      throw new Error('The repository closed. Select the files again.');
    const recovery = await startSelectedChangeRecovery(reads, id, {
      root: root.fsPath,
      kind: action.kind,
      paths,
      head: action.expectedHeadSha,
      branch: `refs/heads/${action.expectedBranch}`,
    });

    try {
      await access.repository(id).apply(patch, {
        threeWay: true,
        reverse: action.kind === 'revert-files',
      });
    } catch (error) {
      if (
        !(
          await cli.run(id, [
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
            '--ignored=matching',
            '--',
            ...pathspecs,
          ])
        ).length
      )
        await recovery.clear();
      throw new GitRequiresSourceControl(
        `${action.kind === 'revert-files' ? 'Reverting' : 'Applying'} selected changes stopped. Review Source Control before retrying; any applied changes remain uncommitted. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    // Native apply cannot be cancelled mid-write. Settle success despite Log navigation.
    await recovery.clear();
  } finally {
    subscription.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
