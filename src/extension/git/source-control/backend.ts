import * as vscode from 'vscode';

import type {
  CommitMode,
  SourceControlRepositoryAction,
  Stash,
  StashFile,
  WorkingFile,
} from '../../../shared/source-control';
import { getGitApi } from '../api';
import { backgroundRead } from '../background-read';
import { updateCheckout } from '../branch-update-target';
import {
  clearSelectedChangeRecovery,
  readSelectedChangeRecovery,
} from '../selected-change-recovery';
import { stashChangeUris, workingChangeUris } from './comparisons';
import { readSourceControlOperation } from './operation-state';
import { prepareSourceControlAbort } from './prepared-abort';
import { prepareBranchCreation } from './prepared-branch';
import { prepareChanges } from './prepared-changes';
import { prepareDiscard } from './prepared-discard';
import {
  type FileWriteAction,
  prepareFileAction,
} from './prepared-file-action';
import { prepareRollback } from './prepared-rollback';
import { prepareStash } from './prepared-stash';
import { createRepositoryAccess } from './repository';
import { readSelectedPatch, validateSelectedPatch } from './selected-patch';
import { readStashes, readStashFiles } from './stashes';
import { readWorkingChanges } from './working-changes';

export async function createSourceControlBackend(signal?: AbortSignal) {
  const access = await getGitApi(signal);

  signal?.throwIfAborted();
  const repositories = createRepositoryAccess(access);

  return {
    repositories: repositories.repositories,
    subscribeRepositories: repositories.subscribeRepositories,
    subscribe: repositories.subscribe,
    dispose: repositories.dispose,
    root: (id: string) => repositories.lease(id).root,
    status: (id: string) => repositories.lease(id).current().status(),
    prepareBranchCreation: (id: string) =>
      prepareBranchCreation(repositories.lease(id), id),
    repositoryAction(options: {
      id: string;
      kind: Exclude<SourceControlRepositoryAction, 'new-branch'>;
      beforeWrite: () => void;
    }) {
      const lease = repositories.lease(options.id);
      const commands = {
        pull: 'git.pull',
        push: 'git.push',
        fetch: 'git.fetch',
        'checkout-branch': 'git.checkout',
        'new-branch-checkout': 'git.branch',
        'new-branch-from': 'git.branchFrom',
        'merge-current': 'git.merge',
        'rebase-current': 'git.rebase',
        'rename-current-branch': 'git.renameBranch',
        'delete-local-branch': 'git.deleteBranch',
        'delete-remote-branch': 'git.deleteRemoteBranch',
        'publish-branch': 'git.publish',
        'create-tag': 'git.createTag',
        'delete-tag': 'git.deleteTag',
        'delete-remote-tag': 'git.deleteRemoteTag',
        'push-tags': 'git.pushTags',
      } satisfies Record<
        Exclude<SourceControlRepositoryAction, 'new-branch'>,
        string
      >;

      return lease.write(options.beforeWrite, async () => {
        // The native Git command owns its picker, confirmations and completion.
        await vscode.commands.executeCommand(
          commands[options.kind],
          lease.root,
        );
      });
    },
    headCommit: (id: string, signal?: AbortSignal) =>
      backgroundRead(
        () => repositories.lease(id).current().getCommit('HEAD'),
        signal,
      ),
    workingChanges: (id: string, signal?: AbortSignal) =>
      readWorkingChanges(repositories.lease(id).cli.readOnly(signal), id),
    operation(id: string, signal?: AbortSignal) {
      const lease = repositories.lease(id);

      // Reconcile only under the shared writer queue, after an in-flight patch settles.
      return lease.write(
        () => {},
        async (writer) => {
          const cli = writer.readOnly(signal);
          const record = await readSelectedChangeRecovery(
            cli,
            id,
            lease.root.fsPath,
          );

          if (record) {
            const checkout = await updateCheckout(cli, id);

            if (
              checkout.sha !== record.head ||
              checkout.ref !== record.branch ||
              !(
                await cli.run(id, [
                  'status',
                  '--porcelain=v1',
                  '-z',
                  '--untracked-files=all',
                  '--ignored=matching',
                  '--',
                  ...record.paths.map((path) => `:(literal)${path}`),
                ])
              ).length
            )
              await clearSelectedChangeRecovery(cli, id, record);
          }

          return readSourceControlOperation(cli, id, lease.root.fsPath);
        },
        { signal },
      );
    },
    prepareAbort(id: string, token: string) {
      const lease = repositories.lease(id);

      return prepareSourceControlAbort(lease, { id, token }, async (kind) => {
        if (kind === 'merge') await lease.current().mergeAbort();
        // The built-in rebase command misses linked worktrees and pauses before REBASE_HEAD.
        // Choose the narrow Git API gap before writing; never retry a failed native action.
        else if (kind === 'revert' || kind === 'rebase')
          await lease.cli.run(id, [kind, '--abort']);
        else
          await vscode.commands.executeCommand(
            'git.cherryPickAbort',
            lease.root,
          );
      });
    },
    stashes: (id: string, signal?: AbortSignal) =>
      readStashes(repositories.lease(id).cli.readOnly(signal), id),
    stashFiles: (id: string, stash: Stash) =>
      backgroundRead((signal) =>
        readStashFiles(repositories.lease(id).cli.readOnly(signal), id, stash),
      ),
    prepareChanges: (options: {
      id: string;
      files: readonly WorkingFile[];
      mode: CommitMode;
    }) => prepareChanges(repositories.lease(options.id), options),
    prepareStash: (options: { id: string; sha: string }) =>
      prepareStash(repositories.lease(options.id), options),
    prepareRollback: (options: { id: string; files: readonly WorkingFile[] }) =>
      prepareRollback(repositories.lease(options.id), options),
    prepareFileAction: (options: {
      id: string;
      files: readonly WorkingFile[];
      kind: FileWriteAction;
    }) =>
      prepareFileAction(repositories.lease(options.id), {
        ...options,
        protectionPaths: () =>
          vscode.workspace.textDocuments
            .filter(
              (document) => document.isDirty && document.uri.scheme === 'file',
            )
            .map((document) => document.uri.fsPath),
      }),
    prepareDiscard: (options: { id: string; path: string }) =>
      prepareDiscard(repositories.lease(options.id), options),
    async messagePatch(
      id: string,
      files: readonly WorkingFile[],
      cancellation?: AbortSignal,
    ) {
      const lease = repositories.lease(id);
      const patch = await readSelectedPatch(lease.cli, id, files, cancellation);

      return {
        patch,
        validate: () =>
          validateSelectedPatch(lease.cli, id, patch, cancellation),
      };
    },
    workingComparison(id: string, file: WorkingFile, index = false) {
      const lease = repositories.lease(id);

      return workingChangeUris(
        { ...access, repository: () => lease.current() },
        lease.cli,
        id,
        file,
        index,
      );
    },
    stashComparison(id: string, file: StashFile) {
      const lease = repositories.lease(id);

      return stashChangeUris(
        { ...access, repository: () => lease.current() },
        id,
        file,
      );
    },
  };
}

export type SourceControlBackend = Awaited<
  ReturnType<typeof createSourceControlBackend>
>;
