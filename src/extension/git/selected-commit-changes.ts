import {
  lstat,
  mkdtemp,
  opendir,
  readlink,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize, resolve } from 'node:path';

import type { FileChange, GitAction } from '../../shared/model';
import { hasErrorCode } from '../../shared/validation';
import type { GitApiAccess } from './api';
import { updateCheckout } from './branch-update-target';
import { rootChanges } from './changes';
import type { GitCli } from './cli';
import { readObjectParents } from './parents';
import { readWithCancellation } from './read-cancellation';
import {
  GitRequiresSourceControl,
  requireNoGitOperation,
} from './working-tree-state';

type SelectedChanges = Extract<
  GitAction,
  { kind: 'cherry-pick-files' | 'revert-files' }
>;

const identity = (file: FileChange) =>
  JSON.stringify([file.status, file.oldPath, file.newPath]);
const pathsOf = (file: FileChange) =>
  [file.oldPath, file.newPath].filter((path): path is string => path !== null);

const filenameIdentity = (path: string) => {
  const normalized = normalize(path);

  // macOS APFS/HFS+ names can be canonically equivalent without matching bytes.
  return process.platform === 'darwin'
    ? normalized.normalize('NFD')
    : normalized;
};

const varyCase = (name: string) =>
  name.replace(/[a-z]/i, (letter) =>
    letter === letter.toLowerCase()
      ? letter.toUpperCase()
      : letter.toLowerCase(),
  );

/** Infer case handling from existing entries without creating files or trusting Git config. */
async function directoryIgnoresCase(directory: string): Promise<boolean> {
  const current = await lstat(directory);
  const parent = dirname(directory);
  const parentInfo = await lstat(parent);
  const sameEntry = async (path: string) => {
    const original = await lstat(path);
    const alternate = join(dirname(path), varyCase(basename(path)));

    try {
      const candidate = await lstat(alternate);

      return (
        !candidate.isSymbolicLink() &&
        candidate.dev === original.dev &&
        candidate.ino === original.ino
      );
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;

      return false;
    }
  };

  if (
    parent !== directory &&
    parentInfo.dev === current.dev &&
    varyCase(basename(directory)) !== basename(directory)
  )
    return sameEntry(directory);
  for await (const entry of await opendir(directory)) {
    if (entry.isSymbolicLink() || varyCase(entry.name) === entry.name) continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);

    if (info.dev !== current.dev || (info.isFile() && info.nlink > 1)) continue;

    return sameEntry(path);
  }

  if (parent !== directory && parentInfo.dev === current.dev)
    return directoryIgnoresCase(parent);
  throw new Error('Cannot verify unsaved file names on this filesystem.');
}

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
    const caseRules = new Map<string, Promise<boolean>>();
    const canonical = async (path: string) => {
      let ancestor = normalize(path);
      const missing: string[] = [];
      let links = 0;
      let resolved: string;
      let existing: string;

      for (;;) {
        try {
          existing = await realpath(ancestor);
          resolved = join(existing, ...missing);
          break;
        } catch (error) {
          if (!hasErrorCode(error, 'ENOENT')) throw error;
          let link: string | null;

          try {
            link = await readlink(ancestor);
          } catch (linkError) {
            if (
              !hasErrorCode(linkError, 'ENOENT') &&
              !hasErrorCode(linkError, 'EINVAL')
            )
              throw linkError;
            link = null;
          }

          if (link !== null) {
            if (++links > 40)
              throw new Error(
                'Too many folder aliases to verify unsaved edits.',
                { cause: error },
              );
            ancestor = resolve(await realpath(dirname(ancestor)), link);
            continue;
          }

          const parent = dirname(ancestor);

          if (parent === ancestor) throw error;
          missing.unshift(basename(ancestor));
          ancestor = parent;
        }
      }

      if (missing.length) {
        let ignoresCase = caseRules.get(existing);

        if (!ignoresCase) {
          ignoresCase = directoryIgnoresCase(existing);
          caseRules.set(existing, ignoresCase);
        }

        if (await ignoresCase) return filenameIdentity(resolved.toLowerCase());
      }

      return filenameIdentity(resolved);
    };

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
      if ((await reads.run(id, ['ls-files', '--unmerged', '-z'])).length)
        throw new GitRequiresSourceControl(
          'Resolve existing conflicts in Source Control before applying selected changes.',
        );
      const protectedPaths = new Set(
        await Promise.all(
          (access.worktreeProtectionPaths?.() ?? []).map(canonical),
        ),
      );

      if (
        (
          await Promise.all(
            paths.map((path) => canonical(join(root.fsPath, path))),
          )
        ).some((path) => protectedPaths.has(path))
      )
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
    try {
      await access.repository(id).apply(patch, {
        threeWay: true,
        reverse: action.kind === 'revert-files',
      });
    } catch (error) {
      throw new GitRequiresSourceControl(
        `${action.kind === 'revert-files' ? 'Reverting' : 'Applying'} selected changes stopped. Review Source Control before retrying; any applied changes remain uncommitted. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  } finally {
    subscription.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
