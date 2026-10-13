import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { GitAction, Reference } from '../../shared/model';
import { hasErrorCode } from '../../shared/validation';
import type { GitRepository } from './api';
import type { GitCli } from './cli';
import { GitPartialCompletion } from './partial-completion';
import { readWithCancellation } from './read-cancellation';

type Creation = Extract<GitAction, { kind: 'create-worktree' }>;

export async function createBranchWorktree(
  repo: Pick<GitRepository, 'createWorktree' | 'setBranchUpstream'>,
  cli: Pick<GitCli, 'run'>,
  id: string,
  action: Creation,
  reference: () => Promise<Reference>,
  signal?: AbortSignal,
): Promise<string> {
  const source = await readWithCancellation(async () => {
    if (!isAbsolute(action.path) || action.path.includes('\0'))
      throw new Error('Choose an absolute folder path for the worktree.');
    let exists = true;

    try {
      await lstat(action.path);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
      exists = false;
    }

    if (exists)
      throw new Error('Choose a new folder. The selected path already exists.');
    const source = await reference();

    if (
      source.kind === 'tag' ||
      (action.name === null && source.kind !== 'local')
    )
      throw new Error(
        'Select a branch and create a local branch for a remote worktree.',
      );
    if (source.name.startsWith('-'))
      throw new Error(
        'Choose a branch name without a leading option character.',
      );
    if (action.name !== null) {
      if (!action.name || action.name.startsWith('-'))
        throw new Error('Enter a valid new branch name.');
      await cli.run(id, ['check-ref-format', '--branch', action.name], signal);
    }

    await reference();
    signal?.throwIfAborted();

    return source;
  }, signal);
  const path = await repo.createWorktree({
    path: action.path,
    commitish: action.name === null ? source.name : action.expectedSha,
    ...(action.name === null ? {} : { branch: action.name }),
  });
  const completed = `Created worktree for "${action.name ?? source.name}" at ${path}.`;
  let failed = 'Its commit could not be verified.';

  try {
    const head = (
      await cli.run(id, ['-C', path, 'rev-parse', '--verify', 'HEAD^{commit}'])
    ).trim();

    if (head !== action.expectedSha)
      throw new Error(
        'The branch changed while creating the worktree. Check its history in the Worktrees view.',
      );
    if (source.kind === 'remote' && action.name !== null) {
      failed = `Tracking to "${source.name}" could not be set.`;
      await repo.setBranchUpstream(action.name, source.name);
    }

    return completed;
  } catch (error) {
    throw new GitPartialCompletion(completed, failed, error);
  }
}
