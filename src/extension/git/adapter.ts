import type { Disposable } from 'vscode';
import { window, workspace } from 'vscode';

import type {
  AuthorIdentity,
  CommitRangeTarget,
  FileChange,
  GitAction,
  HistoryEnrichment,
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
import { watchHistoryShallow } from '../native/history-shallow-watch';
import { getGitApi } from './api';
import { createBlameQueries } from './blame';
import type { BlameQuery, BlameResult } from './blame-model';
import { createChangeQueries } from './changes';
import { GitCli } from './cli';
import type { CommitSuffixSnapshot } from './commit-suffix';
import { validateCommitSuffix } from './commit-suffix';
import type { HistoryReadOptions } from './history';
import { createHistoryQueries } from './history';
import { createHistoryMaintenance } from './history-maintenance';
import { createHistoryShallow } from './history-shallow';
import { validateMessageEdit } from './message-edit';
import type { OperationDialogs } from './operations';
import { createOperations } from './operations';
import { queryRead } from './query-read';
import { createRecoveryScheduler } from './recovery-scheduler';
import type { RepositoryEvent } from './repository-event';
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
  references(repositoryId: string, signal?: AbortSignal): Promise<Reference[]>;
  history(
    repositoryId: string,
    input: HistoryInput,
    signal?: AbortSignal,
    onReferences?: (references: Reference[]) => Promise<void>,
    onEnrichment?: (pending: Promise<HistoryEnrichment>) => void,
    options?: HistoryReadOptions,
  ): Promise<HistoryPage>;
  resolve(
    repositoryId: string,
    input: string,
    signal?: AbortSignal,
  ): Promise<ResolveResult>;
  changes(
    repositoryId: string,
    sha: string,
    parentSha: string | null,
    signal?: AbortSignal,
  ): Promise<FileChange[]>;
  worktrees(
    repositoryId: string,
    signal?: AbortSignal,
  ): Promise<WorktreeInfo[]>;
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
  subscribeRepositories(changed: (event?: RepositoryEvent) => void): Disposable;
  dispose(): void;
}
export async function createGitAdapter(
  dialogs: OperationDialogs = operationDialogs,
  squash?: { runtime: SquashRuntime; storageDirectory: string },
  signal?: AbortSignal,
): Promise<GitAdapter> {
  const access = await getGitApi(signal);
  const cli = new GitCli(access);
  const shallow = createHistoryShallow(access, cli.readOnly());
  const history = createHistoryQueries(
    access,
    cli.readOnly(),
    Date.now,
    shallow,
  );
  const maintenance = createHistoryMaintenance({
    access,
    cli,
    isEnabled: (id) =>
      workspace
        .getConfiguration('gitUI.history', access.repository(id).rootUri)
        .get<boolean>('optimizeRepository', true),
    isTrusted: () => workspace.isTrusted,
  });
  const changes = createChangeQueries(access, cli.readOnly());
  const services = squash
    ? {
        runtime: { ...squash.runtime },
        recovery: new SquashRecovery(squash.storageDirectory, cli),
      }
    : undefined;
  let recoveryFailure: string | null = null;
  let disposed = false;
  const recovery = createRecoveryScheduler({
    reconcile: async () => services?.recovery.reconcile(),
    publish(result) {
      if (result.kind === 'success') {
        recoveryFailure = null;

        return;
      }

      const { error } = result;
      const message = `Squash recovery storage could not be checked: ${error instanceof Error ? error.message : String(error)} Squashing remains unavailable; repository browsing is still available.`;

      if (message !== recoveryFailure)
        void window.showErrorMessage(message, 'Dismiss');
      recoveryFailure = message;
    },
  });
  const reconcileRecovery = async () => {
    if (disposed) throw new Error('Git adapter is disposed.');
    await recovery.reconcile();
    if (disposed) throw new Error('Git adapter is disposed.');
  };

  await reconcileRecovery();
  signal?.throwIfAborted();
  const observations = createRepositoryObservations({
    access,
    shallow,
    watchShallow: (id, changed) => watchHistoryShallow(shallow, id, changed),
    invalidate: (id) => {
      history.invalidate(id);
      changes.invalidate(id);
    },
    onEvent: () => {
      void recovery.reconcile();
    },
  });
  const operate = createOperations(access, cli, dialogs, services);
  const maintenanceLifetime = observations.subscribeRepositories((event) => {
    if (event) maintenance.invalidate(event.repositoryId);
  });

  return {
    blame: (query, signal) =>
      queryRead('blame', query.repositoryId, signal, (owner) =>
        createBlameQueries(
          access,
          cli.readOnly(owner),
          nativeBlameCodec,
        )(query, owner),
      ),
    invalidateHistory: (id) => history.invalidate(id),
    authors: (id, signal) =>
      queryRead('authors', id, signal, (owner) => history.authors(id, owner)),
    repositories: () => access.repositories(),
    references: (id, signal) =>
      queryRead('references', id, signal, (owner) =>
        readReferences(access, id, cli.readOnly(owner)),
      ),
    history: (id, input, signal, onReferences, onEnrichment, options) =>
      queryRead('history', id, signal, async (owner) => {
        await observations.settled(id);
        owner.throwIfAborted();

        const page = await history.page(
          id,
          input,
          owner,
          onReferences,
          onEnrichment,
          options,
        );

        maintenance.request(id);

        return page;
      }),
    resolve: (id, input, signal) =>
      queryRead('resolve', id, signal, (owner) =>
        resolveCommit(access, cli.readOnly(owner), id, input),
      ),
    changes: (id, sha, parent, signal) =>
      queryRead('changes', id, signal, (owner) =>
        changes(id, sha, parent, owner),
      ),
    worktrees: (id, signal) =>
      queryRead('worktrees', id, signal, (owner) =>
        readWorktrees(access, cli.readOnly(owner), id),
      ),
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
    dispose() {
      if (disposed) return;
      disposed = true;
      recovery.dispose();
      maintenanceLifetime.dispose();
      maintenance.dispose();
      history.dispose();
      changes.dispose();
      observations.dispose();
    },
  };
}
