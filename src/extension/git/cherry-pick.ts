import type { CommitRangeTarget } from '../../shared/model';
import { isReadCancellation, readWithCancellation } from '../read-cancellation';
import type { GitApiAccess } from './api';
import type { GitCli } from './cli';
import { actualParents } from './parents';
import {
  GitRequiresSourceControl,
  requireCleanWorkingTree,
  requireNoGitOperation,
} from './working-tree-state';

export async function cherryPickCommits(
  access: GitApiAccess,
  cli: Pick<GitCli, 'run'>,
  id: string,
  target: CommitRangeTarget,
  context?: AbortSignal,
): Promise<void> {
  const fullIdentity = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
  const reads: Pick<GitCli, 'run'> = {
    run: (repositoryId, args) => cli.run(repositoryId, args, context),
  };

  if (
    !target.shas.length ||
    !target.shas.every((sha) => fullIdentity.test(sha)) ||
    new Set(target.shas.map((sha) => sha.toLowerCase())).size !==
      target.shas.length ||
    !fullIdentity.test(target.expectedHeadSha)
  )
    throw new Error('Select distinct full commit identities.');
  if (target.shas.length > 400)
    throw new Error('Cherry-pick up to 400 commits at a time.');
  await readWithCancellation(async () => {
    for (const sha of target.shas) {
      const commit = await readWithCancellation(
        () => access.repository(id).getCommit(sha),
        context,
      );

      if (
        commit.hash !== sha ||
        (await actualParents(commit, reads, id)).length > 1
      )
        throw new Error(
          'Merge cherry-picking requires a mainline choice and is unavailable.',
        );
    }
  }, context);

  const preflight = async () =>
    readWithCancellation(async () => {
      await requireNoGitOperation(reads, id, 'cherry-picking');
      await requireCleanWorkingTree(
        reads,
        id,
        'Commit or stash local changes in Source Control before cherry-picking.',
      );
      const branch = (
        await reads.run(id, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      ).trim();
      const head = (
        await readWithCancellation(
          () => access.repository(id).getCommit('HEAD'),
          context,
        )
      ).hash;

      if (branch !== target.expectedBranch || head !== target.expectedHeadSha)
        throw new Error(
          'The target branch or HEAD changed. Select the commits again.',
        );
      context?.throwIfAborted();
      access.repository(id);
    }, context);

  await preflight();
  try {
    // Git owns partial progress. VS Code exposes Abort, but no sequence Continue/Skip command.
    await cli.run(id, ['cherry-pick', ...target.shas], undefined, preflight);
  } catch (error) {
    if (context && isReadCancellation(error, context)) throw error;
    throw new GitRequiresSourceControl(
      'Cherry-pick stopped. Resolve changes in Source Control. Continue or skip with Git in the terminal, or use Git: Abort Cherry-Pick.',
      { cause: error },
    );
  }
}
