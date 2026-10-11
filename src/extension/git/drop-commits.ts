import type { CommitRangeTarget } from '../../shared/model';
import type { GitApiAccess } from './api';
import type { GitCli } from './cli';
import { attachedBranch, validateCommitSuffix } from './commit-suffix';
import { GitPartialCompletion } from './partial-completion';
import { readWithCancellation } from './read-cancellation';

export async function dropCommits(
  access: GitApiAccess,
  cli: Pick<GitCli, 'run'>,
  id: string,
  target: CommitRangeTarget,
  context?: AbortSignal,
): Promise<string> {
  const reads: Pick<GitCli, 'run'> = {
    run: (repositoryId, args) => cli.run(repositoryId, args, context),
  };
  const validate = () =>
    readWithCancellation(
      () => validateCommitSuffix(access, reads, id, target, 'drop'),
      context,
    );
  const snapshot = await validate();
  const preflight = async () => {
    context?.throwIfAborted();
    await validate();
    context?.throwIfAborted();
    access.repository(id);
  };

  await preflight();
  // A complete suffix requires no replay. --keep refuses to overwrite local edits.
  await cli.run(
    id,
    ['reset', '--keep', snapshot.oldestParentSha],
    undefined,
    preflight,
  );
  try {
    const head = (
      await cli.run(id, ['rev-parse', '--verify', 'HEAD^{commit}'])
    ).trim();

    if (
      head !== snapshot.oldestParentSha ||
      (await attachedBranch(cli, id)) !== target.expectedBranch
    )
      throw new Error(
        'The surviving commit or checked-out branch differs from the selected base.',
      );
    if (
      (
        await cli.run(id, [
          'status',
          '--porcelain',
          '--untracked-files=all',
          '--ignore-submodules=none',
          '-z',
        ])
      ).length
    )
      throw new Error(
        'The working tree changed before the result could be verified.',
      );

    return head;
  } catch (error) {
    throw new GitPartialCompletion(
      `Git dropped ${target.shas.length} commit${target.shas.length === 1 ? '' : 's'} from "${target.expectedBranch}".`,
      `Result verification failed. Previous HEAD: ${target.expectedHeadSha}.`,
      error,
    );
  }
}
