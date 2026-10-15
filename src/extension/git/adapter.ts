import type { Disposable } from 'vscode';
import { window } from 'vscode';

import type {
  AuthorIdentity,
  CommitRangeTarget,
  FileChange,
  GitAction,
  HistoryInput,
  HistoryPage,
  OperationResult,
  Reference,
  RepositoryInfo,
  ResolveResult,
  WorktreeInfo,
} from '../../shared/model';
import { nativeBlameCodec } from '../native/blame-encoding';
import { operationDialogs } from '../native/dialogs';
import { getGitApi } from './api';
import { createBlameQueries } from './blame';
import type { BlameQuery, BlameResult } from './blame-model';
import { createChangeQueries } from './changes';
import { GitCli } from './cli';
import type { CommitSuffixSnapshot } from './commit-suffix';
import { validateCommitSuffix } from './commit-suffix';
import { createHistoryQueries } from './history';
import { validateMessageEdit } from './message-edit';
import type { OperationDialogs } from './operations';
import { createOperations } from './operations';
import { createRepositoryObservations } from './repository-observations';
import { readReferences, resolveCommit } from './resolve';
import type { SquashSnapshot } from './squash';
import { validateSquash } from './squash';
import type { SquashRuntime } from './squash-editor';
import { probeSquashRuntime } from './squash-editor';
import { SquashRecovery } from './squash-recovery';
import { readWorktrees } from './worktrees';

export interface GitAdapter {
  blame(query: BlameQuery, signal?: AbortSignal): Promise<BlameResult>;
  invalidateHistory(repositoryId: string): void;
  authors(
    repositoryId: string,
    signal?: AbortSignal,
  ): Promise<AuthorIdentity[]>;
  repositories(): RepositoryInfo[];
  references(repositoryId: string): Promise<Reference[]>;
  history(
    repositoryId: string,
    input: HistoryInput,
    signal?: AbortSignal,
    onReferences?: (references: Reference[]) => Promise<void>,
  ): Promise<HistoryPage>;
  resolve(repositoryId: string, input: string): Promise<ResolveResult>;
  changes(
    repositoryId: string,
    sha: string,
    parentSha: string | null,
  ): Promise<FileChange[]>;
  worktrees(repositoryId: string): Promise<WorktreeInfo[]>;
  prepareMessageEdit(
    repositoryId: string,
    sha: string,
    branch: string,
    headSha: string,
  ): Promise<void>;
  prepareSquash(
    repositoryId: string,
    target: CommitRangeTarget,
  ): Promise<SquashSnapshot>;
  prepareDrop(
    repositoryId: string,
    target: CommitRangeTarget,
  ): Promise<CommitSuffixSnapshot>;
  operate(
    repositoryId: string,
    action: GitAction,
    context?: AbortSignal,
    progress?: (phase: 'waiting' | 'running') => Promise<void>,
  ): Promise<OperationResult>;
  subscribe(repositoryId: string, changed: () => void): Disposable;
  subscribeRepositories(changed: () => void): Disposable;
  dispose(): void;
}
export async function createGitAdapter(
  dialogs: OperationDialogs = operationDialogs,
  squash?: { runtime: SquashRuntime; storageDirectory: string },
  signal?: AbortSignal,
): Promise<GitAdapter> {
  const access = await getGitApi(signal);
  const cli = new GitCli(access);
  const history = createHistoryQueries(access, cli);
  const services = squash
    ? {
        runtime: { ...squash.runtime },
        recovery: new SquashRecovery(squash.storageDirectory, cli),
      }
    : undefined;
  let recoveryFailure: string | null = null;
  const reconcileRecovery = async () => {
    try {
      await services?.recovery.reconcile();
      recoveryFailure = null;
    } catch (error) {
      const message = `Squash recovery storage could not be checked: ${error instanceof Error ? error.message : String(error)} Squashing remains unavailable; repository browsing is still available.`;

      if (message !== recoveryFailure)
        void window.showErrorMessage(message, 'Dismiss');
      recoveryFailure = message;
    }
  };

  await reconcileRecovery();
  signal?.throwIfAborted();
  const observations = createRepositoryObservations({
    access,
    invalidate: (id) => history.invalidate(id),
    onEvent: () => {
      void reconcileRecovery();
    },
  });
  const operate = createOperations(access, cli, dialogs, services);

  return {
    blame: createBlameQueries(access, cli, nativeBlameCodec),
    invalidateHistory: (id) => history.invalidate(id),
    authors: (id, signal) => history.authors(id, signal),
    repositories: () => access.repositories(),
    references: (id) => readReferences(access, id, cli),
    history: async (id, input, signal, onReferences) => {
      await observations.settled(id);

      return history.page(id, input, signal, onReferences);
    },
    resolve: (id, input) => resolveCommit(access, cli, id, input),
    changes: createChangeQueries(access, cli),
    worktrees: (id) => readWorktrees(access, cli, id),
    operate: async (id, action, context, progress) => {
      if (
        action.kind === 'squash-commits' ||
        action.kind === 'edit-commit-message'
      ) {
        await reconcileRecovery();
        if (recoveryFailure)
          return { kind: 'error', backend: null, message: recoveryFailure };
      }

      // History reads own metadata settling; a finished write releases its lane.
      return operate(id, action, context, progress);
    },
    prepareMessageEdit: async (id, sha, branch, headSha) => {
      if (sha !== headSha) {
        if (!services)
          throw new Error('The history editing helper runtime is unavailable.');
        await reconcileRecovery();
        if (recoveryFailure) throw new Error(recoveryFailure);
        await probeSquashRuntime(services.runtime);
      }

      await validateMessageEdit(access, cli, id, sha, branch, headSha);
    },
    prepareDrop: (id, target) =>
      validateCommitSuffix(access, cli, id, target, 'drop'),
    prepareSquash: async (id, target) => {
      if (!services)
        throw new Error(
          'Squashing is unavailable because its private helper runtime is not configured.',
        );
      await reconcileRecovery();
      if (recoveryFailure) throw new Error(recoveryFailure);
      await probeSquashRuntime(services.runtime);

      return validateSquash(access, cli, id, target);
    },
    subscribe: observations.subscribe,
    subscribeRepositories: observations.subscribeRepositories,
    dispose: observations.dispose,
  };
}
