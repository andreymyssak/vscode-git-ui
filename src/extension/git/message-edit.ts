import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extensionIdentity } from '../../shared/extension-identity';
import type { GitAction } from '../../shared/model';
import { readWithCancellation } from '../read-cancellation';
import type { GitApiAccess } from './api';
import type { GitCli } from './cli';
import type { CommitRewriteSnapshot } from './commit-rewrite';
import { validateRewriteRange } from './commit-rewrite';
import { attachedBranch, readCommit } from './commit-suffix';
import { supportsSquashGit, validateSquashMessage } from './squash';
import { createSquashEditors, probeSquashRuntime } from './squash-editor';
import type { SquashServices } from './squash-operation';
import {
  requireCleanWorkingTree,
  requireNoGitOperation,
} from './working-tree-state';

export async function validateMessageEdit(
  access: GitApiAccess,
  cli: Pick<GitCli, 'run'>,
  id: string,
  sha: string,
  expectedBranch: string,
  expectedHeadSha: string,
): Promise<CommitRewriteSnapshot | null> {
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha))
    throw new Error('Select a full commit identity.');
  if (sha !== expectedHeadSha) {
    if (!supportsSquashGit(await cli.run(id, ['--version'])))
      throw new Error('Editing older messages requires Git 2.47 or newer.');

    return validateRewriteRange(
      access,
      cli,
      id,
      { shas: [sha], expectedBranch, expectedHeadSha },
      1,
    );
  }

  await requireNoGitOperation(cli, id, 'editing the commit message');
  await requireCleanWorkingTree(
    cli,
    id,
    'Commit or stash working changes in Source Control before editing the commit message.',
  );
  if (
    (
      await cli.run(id, [
        'for-each-ref',
        `--contains=${sha}`,
        '--format=%(refname)',
        'refs/remotes',
      ])
    ).trim()
  )
    throw new Error(
      'This commit is in known remote history. Published commits cannot be edited here.',
    );
  if (
    (await attachedBranch(cli, id)) !== expectedBranch ||
    (await cli.run(id, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !==
      expectedHeadSha
  )
    throw new Error(
      'The current branch or HEAD changed. Select the commit again.',
    );

  return null;
}

export async function editCommitMessage(
  access: GitApiAccess,
  cli: Pick<GitCli, 'run'>,
  id: string,
  action: Extract<GitAction, { kind: 'edit-commit-message' }>,
  services: SquashServices | undefined,
  context?: AbortSignal,
): Promise<string> {
  validateSquashMessage(action.message);
  const reads: Pick<GitCli, 'run'> = {
    run: (repositoryId, args) => cli.run(repositoryId, args, context),
  };
  const validate = () =>
    readWithCancellation(
      () =>
        validateMessageEdit(
          access,
          reads,
          id,
          action.sha,
          action.expectedBranch,
          action.expectedHeadSha,
        ),
      context,
    );
  const snapshot = await validate();

  if (snapshot) {
    if (!services)
      throw new Error('The history editing helper runtime is unavailable.');
    await probeSquashRuntime(services.runtime);
    context?.throwIfAborted();
    const { directory, inputPath } = await services.recovery.create(
      id,
      snapshot,
      action.message,
      'reword',
    );

    try {
      await cli.run(
        id,
        [
          '-c',
          'rebase.instructionFormat=%s',
          '-c',
          'rebase.abbreviateCommands=false',
          '-c',
          `core.abbrev=${action.expectedHeadSha.length}`,
          '-c',
          'core.commentChar=#',
          '-c',
          'commit.cleanup=verbatim',
          'rebase',
          '--interactive',
          '--force-rebase',
          '--no-autostash',
          '--no-autosquash',
          '--no-fork-point',
          '--no-rebase-merges',
          '--no-update-refs',
          '--keep-empty',
          '--empty=keep',
          '--reapply-cherry-picks',
          '--strategy=ort',
          snapshot.oldestParentSha,
        ],
        undefined,
        async () => {
          context?.throwIfAborted();
          await validate();
          context?.throwIfAborted();
        },
        createSquashEditors(services.runtime, inputPath),
      );
      const range = (
        await cli.run(id, [
          'rev-list',
          '--reverse',
          `${snapshot.oldestParentSha}..HEAD`,
        ])
      )
        .trim()
        .split('\n');
      const head = await readCommit(cli, id, 'HEAD');
      const replacement = range[0]!;
      const edited = await readCommit(cli, id, replacement);

      if (
        (await attachedBranch(cli, id)) !== action.expectedBranch ||
        range.length !== snapshot.replayShas.length ||
        head.treeSha !== snapshot.treeSha ||
        edited.parents[0] !== snapshot.oldestParentSha
      )
        throw new Error(
          `Message edit verification failed. Old HEAD ${action.expectedHeadSha}; check the current branch in Source Control.`,
        );

      return replacement;
    } finally {
      await services.recovery.settle(id, directory);
    }
  }

  const before = await readWithCancellation(
    () => readCommit(reads, id, action.sha),
    context,
  );
  const directory = await mkdtemp(
    join(tmpdir(), `${extensionIdentity.name}-message-`),
  );

  try {
    const path = join(directory, 'message.txt');

    await writeFile(path, action.message, { mode: 0o600 });
    // One message-only amend; never retry a write through another backend.
    await cli.run(
      id,
      ['commit', '--amend', '--only', '--allow-empty', '--file', path],
      undefined,
      async () => {
        context?.throwIfAborted();
        await validate();
        context?.throwIfAborted();
      },
    );
    const replacement = (
      await cli.run(id, ['rev-parse', '--verify', 'HEAD^{commit}'])
    ).trim();
    const after = await readCommit(cli, id, replacement);

    if (
      (await attachedBranch(cli, id)) !== action.expectedBranch ||
      before.treeSha !== after.treeSha ||
      before.parents.join(',') !== after.parents.join(',')
    )
      throw new Error(
        `Message edit verification failed. Old HEAD ${action.expectedHeadSha}; new HEAD ${replacement}.`,
      );

    return replacement;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
