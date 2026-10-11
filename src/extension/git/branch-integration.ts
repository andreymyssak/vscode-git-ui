import type { GitAction, Reference } from '../../shared/model';
import type { GitRepository } from './api';
import { updateCheckout } from './branch-update-target';
import type { GitCli } from './cli';
import { readWithCancellation } from './read-cancellation';
import {
  requireCleanWorkingTree,
  requireNoGitOperation,
} from './working-tree-state';

type Integration = Extract<
  GitAction,
  { kind: 'merge-branch' | 'rebase-branch' }
>;

/** Integrate a pinned source into the checked-out branch, without switching or fetching. */
export async function integrateBranch(
  repo: Pick<GitRepository, 'merge' | 'rebase'>,
  cli: Pick<GitCli, 'run'>,
  id: string,
  action: Integration,
  reference: () => Promise<Reference>,
  signal?: AbortSignal,
): Promise<string> {
  const method = action.kind === 'merge-branch' ? 'merge' : 'rebase';
  const verb = method === 'merge' ? 'merging' : 'rebasing';
  const preflight: Pick<GitCli, 'run'> = {
    run: (repositoryId, args) => cli.run(repositoryId, args, signal),
  };
  const validate = async () => {
    signal?.throwIfAborted();
    const checkout = await updateCheckout(preflight, id);
    const source = await reference();

    if (!checkout.ref || !action.expectedBranch)
      throw new Error('Check out a branch before merging or rebasing.');
    if (
      checkout.ref !== `refs/heads/${action.expectedBranch}` ||
      checkout.sha !== action.expectedHeadSha
    )
      throw new Error(
        'The checked-out branch changed. Select the action again.',
      );
    if (
      (source.kind !== 'local' && source.kind !== 'remote') ||
      source.id === checkout.ref
    )
      throw new Error('Select another local or remote branch.');
    const symbolic = (
      await preflight.run(id, [
        'for-each-ref',
        '--format=%(refname)%00%(symref)',
        source.id,
      ])
    )
      .split('\n')
      .map((line) => line.split('\0'))
      .find((row) => row[0] === source.id)?.[1];

    if (symbolic)
      throw new Error('Select a direct branch, not a symbolic reference.');
    await requireNoGitOperation(preflight, id, verb);
    await requireCleanWorkingTree(
      preflight,
      id,
      `Commit or stash local changes before ${verb}.`,
    );
    const final = await updateCheckout(preflight, id);

    if (final.ref !== checkout.ref || final.sha !== checkout.sha)
      throw new Error(
        'The checked-out branch changed. Select the action again.',
      );
    await reference();
    signal?.throwIfAborted();

    return source;
  };

  const source = await readWithCancellation(validate, signal);

  await repo[method](action.expectedSha);
  const checkout = await updateCheckout(cli, id);

  if (checkout.ref !== `refs/heads/${action.expectedBranch}`)
    throw new Error(
      'The checkout changed during the operation. Check Source Control.',
    );
  await requireNoGitOperation(cli, id, verb);

  return method === 'merge'
    ? `Merged "${source.name}" into "${action.expectedBranch}".`
    : `Rebased "${action.expectedBranch}" on "${source.name}".`;
}
