import * as vscode from 'vscode';

import type {
  CommitMode,
  Stash,
  StashFile,
  WorkingFile,
} from '../../../shared/source-control';
import { getGitApi } from '../api';
import { updateCheckout } from '../branch-update-target';
import {
  clearSelectedChangeRecovery,
  readSelectedChangeRecovery,
} from '../selected-change-recovery';
import { stashChangeUris, workingChangeUris } from './comparisons';
import { readSourceControlOperation } from './operation-state';
import { prepareSourceControlAbort } from './prepared-abort';
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
    headCommit: (id: string) =>
      repositories.lease(id).current().getCommit('HEAD'),
    workingChanges: (id: string) =>
      readWorkingChanges(repositories.lease(id).cli, id),
    operation(id: string) {
      const lease = repositories.lease(id);

      // Reconcile only under the shared writer queue, after an in-flight patch settles.
      return lease.write(
        () => {},
        async (cli) => {
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
    stashes: (id: string) => readStashes(repositories.lease(id).cli, id),
    stashFiles: (id: string, stash: Stash) =>
      readStashFiles(repositories.lease(id).cli, id, stash),
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
