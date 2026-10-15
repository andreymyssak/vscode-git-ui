import { realpath } from 'node:fs/promises';

import { extensionIdentity } from '../../shared/extension-identity';
import type { BranchUpdateDecision, GitAction } from '../../shared/model';
import type { GitRepository } from './api';
import type { BranchUpdate, UpdateCheckout } from './branch-update-target';
import { updateCheckout, validateUpdateTarget } from './branch-update-target';
import type { GitCli } from './cli';
import { readWithCancellation } from './read-cancellation';

export interface UpdateBranchDialogs {
  updateDiverged?(target: {
    branch: string;
    upstream: string;
    currentBranch: string | null;
  }): Promise<'merge' | 'rebase' | 'checkout' | null>;
}

export class BranchUpdateBlocked extends Error {
  constructor(
    readonly decision: BranchUpdateDecision,
    branch: string,
  ) {
    super(
      `"${branch}" has local commits and incoming changes. ${decision.kind === 'checkout' ? 'Check it out to update it.' : 'Choose Rebase or Merge to update it.'}`,
    );
  }
}

export interface BranchUpdateResult {
  backend: 'api' | 'cli';
  message: string;
}

/** Fetch once, fast-forward when possible, and use native Git for an explicit divergent choice. */
export async function updateBranch(
  repo: Pick<
    GitRepository,
    'rootUri' | 'fetch' | 'getCommit' | 'checkout' | 'merge' | 'rebase'
  >,
  cli: Pick<GitCli, 'run'>,
  id: string,
  action: BranchUpdate,
  dialogs: UpdateBranchDialogs,
  signal?: AbortSignal,
  onWrite?: (backend: 'api' | 'cli') => void,
): Promise<BranchUpdateResult | null> {
  const original = await updateCheckout(cli, id);
  const root = await realpath(repo.rootUri.fsPath);
  const validate = (
    checkout = original,
    tip = action.expectedSha,
    cancellable = true,
    requireClean = false,
  ) =>
    validateUpdateTarget(
      cli,
      id,
      root,
      action,
      checkout,
      tip,
      cancellable ? signal : undefined,
      requireClean,
    );
  const target = await validate();
  const finalCheck = async (
    checkout = original,
    tip = action.expectedSha,
    cancellable = true,
    requireClean = false,
  ) => {
    const final = await validate(checkout, tip, cancellable, requireClean);

    if (final.remote !== target.remote || final.remoteRef !== target.remoteRef)
      throw new Error('The tracked upstream changed. Refresh before updating.');
  };

  // A '.' upstream is already local. Fetching it into a checked-out branch
  // would be refused by Git and is unnecessary for resolving its current tip.
  if (target.remote !== '.')
    await repo.fetch({
      remote: target.remote,
      ref: `${target.remoteRef}:${action.expectedUpstream}`,
    });
  const fetched = (await repo.getCommit(action.expectedUpstream)).hash;

  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(fetched))
    throw new Error(
      'The upstream commit could not be resolved. Refresh before updating.',
    );
  await finalCheck();
  const counts = (
    await cli.run(id, [
      'rev-list',
      '--left-right',
      '--count',
      `${action.expectedSha}...${fetched}`,
    ])
  ).trim();

  if (!/^\d+\s+\d+$/.test(counts))
    throw new Error(
      'The upstream history could not be compared. Refresh before updating.',
    );
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  const branch = action.refId.slice('refs/heads/'.length);
  const incoming = `${behind} incoming commit${behind === 1 ? '' : 's'}`;

  if (!behind)
    return { backend: 'cli', message: `"${branch}" is already up to date.` };
  if (!ahead) {
    onWrite?.('cli');
    await cli.run(
      id,
      original.ref === action.refId
        ? ['merge', '--ff-only', '--no-autostash', fetched]
        : [
            'update-ref',
            '--no-deref',
            '-m',
            `${extensionIdentity.displayName}: fast-forward tracked branch`,
            action.refId,
            fetched,
            action.expectedSha,
          ],
      undefined,
      () =>
        finalCheck(
          original,
          action.expectedSha,
          true,
          original.ref === action.refId,
        ),
    );

    return { backend: 'cli', message: `Updated "${branch}": ${incoming}.` };
  }

  const currentBranch = original.ref?.slice('refs/heads/'.length) ?? null;

  const continuation = {
    target: { ...action },
    checkout: original,
    fetchedSha: fetched,
    incomingCount: behind,
    remote: target.remote,
    remoteRef: target.remoteRef,
  };

  // Report the completed Update before offering a separate optional action.
  if (!dialogs.updateDiverged)
    throw new BranchUpdateBlocked(
      {
        kind: original.ref !== action.refId ? 'checkout' : 'integrate',
        continuation,
      },
      branch,
    );
  const choice = await dialogs.updateDiverged({
    branch,
    upstream: action.expectedUpstream.replace(/^refs\/(?:remotes|heads)\//, ''),
    currentBranch,
  });

  if (choice === null) return null;

  return continueBranchUpdate(
    repo,
    cli,
    id,
    {
      kind: 'continue-update',
      method: choice,
      continuation,
    },
    signal,
    onWrite,
  );
}

/** Resume only the captured Update decision; never fetch or adopt a newer target. */
export async function continueBranchUpdate(
  repo: Pick<
    GitRepository,
    'rootUri' | 'getCommit' | 'checkout' | 'merge' | 'rebase'
  >,
  cli: Pick<GitCli, 'run'>,
  id: string,
  request: Extract<GitAction, { kind: 'continue-update' }>,
  signal?: AbortSignal,
  onWrite?: (backend: 'api' | 'cli') => void,
): Promise<BranchUpdateResult> {
  const {
    target: action,
    checkout: original,
    fetchedSha: fetched,
    remote,
    remoteRef,
  } = request.continuation;
  const choice = request.method;
  const branch = action.refId.slice('refs/heads/'.length);
  const count = request.continuation.incomingCount;
  const incoming = `${count} incoming commit${count === 1 ? '' : 's'}`;
  const root = await realpath(repo.rootUri.fsPath);
  const finalCheck = async (
    checkout = original,
    tip = action.expectedSha,
    cancellable = true,
    requireClean = true,
  ) => {
    const currentUpstream = await readWithCancellation(
      () => repo.getCommit(action.expectedUpstream),
      cancellable ? signal : undefined,
    );

    if (currentUpstream.hash !== fetched)
      throw new Error('The tracked upstream changed. Refresh before updating.');
    const current = await validateUpdateTarget(
      cli,
      id,
      root,
      action,
      checkout,
      tip,
      cancellable ? signal : undefined,
      requireClean,
    );

    if (current.remote !== remote || current.remoteRef !== remoteRef)
      throw new Error('The tracked upstream changed. Refresh before updating.');
    if (cancellable) signal?.throwIfAborted();
  };

  if (original.ref !== action.refId) {
    if (choice !== 'checkout')
      throw new Error('Check out this branch before choosing Merge or Rebase.');
    const before = () => finalCheck(original, action.expectedSha, true, true);

    await before();
    if (branch.startsWith('-')) {
      onWrite?.('cli');
      await cli.run(
        id,
        ['switch', '--no-guess', '--', branch],
        undefined,
        before,
      );
    } else {
      onWrite?.('api');
      await repo.checkout(branch);
    }

    const selected = await updateCheckout(cli, id);

    if (selected.ref !== action.refId || selected.sha !== action.expectedSha)
      throw new Error(
        'The checkout changed while switching branches. Check the current branch in Source Control.',
      );
    await finalCheck(selected, action.expectedSha, false, false);

    return {
      backend: branch.startsWith('-') ? 'cli' : 'api',
      message: `Checked out "${branch}". Choose Update to bring it up to date.`,
    };
  }

  if (choice !== 'merge' && choice !== 'rebase')
    throw new Error('Choose an offered update method.');
  await finalCheck(original, action.expectedSha, true, true);
  const selected: UpdateCheckout = {
    ref: action.refId,
    sha: action.expectedSha,
  };

  try {
    await finalCheck(selected, action.expectedSha, true, true);
    onWrite?.('api');
    await repo[choice](fetched);
    const result = await updateCheckout(cli, id);

    if (result.ref !== action.refId)
      throw new Error('The selected checkout changed during Update.');
    await finalCheck(result, result.sha, false, true);
    await cli.run(id, ['merge-base', '--is-ancestor', fetched, result.sha]);
  } catch (error) {
    throw new Error(
      `Update on "${branch}" stopped. ${error instanceof Error ? error.message : String(error)} The current checkout and Git state were left for Source Control; no rollback was performed.`,
      { cause: error },
    );
  }

  return {
    backend: 'api',
    message: `Updated "${branch}" with ${choice === 'rebase' ? 'Rebase' : 'Merge'}: ${incoming}.`,
  };
}
