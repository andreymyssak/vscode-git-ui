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
import { operationDialogs } from '../native/dialogs';
import { getGitApi } from './api';
import { createBlameQueries } from './blame';
import type { BlameQuery, BlameResult } from './blame-model';
import { createChangeQueries } from './changes';
import { GitCli } from './cli';
import type { CommitSuffixSnapshot } from './commit-suffix';
import { validateCommitSuffix } from './commit-suffix';
import { createHistoryQueries } from './history';
import { historyChangeFilter } from './history-events';
import { validateMessageEdit } from './message-edit';
import type { OperationDialogs } from './operations';
import { createOperations } from './operations';
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
  ): Promise<OperationResult>;
  subscribe(repositoryId: string, changed: () => void): Disposable;
  subscribeRepositories(changed: () => void): Disposable;
  dispose(): void;
}
export async function createGitAdapter(
  dialogs: OperationDialogs = operationDialogs,
  squash?: { runtime: SquashRuntime; storageDirectory: string },
): Promise<GitAdapter> {
  const access = await getGitApi();
  const disposables: Disposable[] = [];
  const cli = new GitCli(access);
  const history = createHistoryQueries(access, cli);
  const observations = new Map<
    string,
    Set<ReturnType<typeof historyChangeFilter>>
  >();
  const settleHistoryEvents = (id: string) =>
    Promise.all(
      [...(observations.get(id) ?? [])].map((observer) => observer.settled()),
    );
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
  const operate = createOperations(access, cli, dialogs, services);

  return {
    blame: createBlameQueries(access, cli),
    invalidateHistory: (id) => history.invalidate(id),
    authors: (id, signal) => history.authors(id, signal),
    repositories: () => access.repositories(),
    references: (id) => readReferences(access, id, cli),
    history: async (id, input, signal) => {
      await settleHistoryEvents(id);

      return history.page(id, input, signal);
    },
    resolve: (id, input) => resolveCommit(access, cli, id, input),
    changes: createChangeQueries(access, cli),
    worktrees: (id) => readWorktrees(access, cli, id),
    operate: async (id, action, context) => {
      if (
        action.kind === 'squash-commits' ||
        action.kind === 'edit-commit-message'
      ) {
        await reconcileRecovery();
        if (recoveryFailure)
          return { kind: 'error', backend: null, message: recoveryFailure };
      }

      const result = await operate(id, action, context);

      // Deliver the write's queued history events before the panel reloads it.
      await settleHistoryEvents(id);

      return result;
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
    subscribe(id, changed) {
      const repository = access.repository(id);
      let active = true;
      const notify = historyChangeFilter(repository, () => {
        if (!active) return;
        history.invalidate(id);
        changed();
      });
      const observers = observations.get(id) ?? new Set();

      observers.add(notify);
      observations.set(id, observers);
      const subscription = repository.state.onDidChange(() => {
        void reconcileRecovery();
        void notify.check();
      });
      const disposable = {
        dispose() {
          active = false;
          observers.delete(notify);
          if (!observers.size) observations.delete(id);
          subscription.dispose();
        },
      };

      disposables.push(disposable);

      return disposable;
    },
    subscribeRepositories(changed) {
      const refresh = () => {
        void reconcileRecovery();
        changed();
      };

      const opened = access.api.onDidOpenRepository(refresh);
      const closed = access.api.onDidCloseRepository(refresh);
      const disposable = {
        dispose() {
          opened.dispose();
          closed.dispose();
        },
      };

      disposables.push(disposable);

      return disposable;
    },
    dispose() {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
