import type {
  PanelBody,
  Request,
  RequestBody,
  UserAction,
} from '../../shared/messages';
import type { GitAction } from '../../shared/model';
import type { GitAdapter } from '../git/adapter';
import type { ActionPrompts, PanelActions } from './actions';
import {
  isHistoryRewrite,
  offerBranchRestore,
  publishOperationResult,
} from './actions';
import { describeLogAction } from './operation-description';
import type { OperationProgress, PanelOperations } from './operation-progress';
import type { QuerySession } from './queries';
import type { DeferredRepositoryRefresh } from './repository-refresh';

interface ActionContext {
  session: QuerySession;
  adapter: GitAdapter;
  actions: PanelActions;
  repositoryRefresh: DeferredRepositoryRefresh;
  operations: PanelOperations;
  progress: OperationProgress;
  options: ActionPrompts & { trusted(): boolean };
  closed(this: void): boolean;
  refresh(this: void): Promise<void>;
  beginWrite(this: void): Promise<() => boolean>;
  send(this: void, body: PanelBody, requestId: string): Promise<void>;
}

/** Keep review, the captured Git write and its result refresh in one lifecycle. */
export async function runPanelAction(
  action: UserAction,
  request: Request<RequestBody>,
  {
    session,
    adapter,
    actions,
    repositoryRefresh,
    operations,
    progress,
    options,
    closed,
    refresh,
    beginWrite,
    send,
  }: ActionContext,
  prepared?: Extract<GitAction, { kind: 'update-branch' }>,
): Promise<void> {
  if (
    closed() ||
    !options.trusted() ||
    (prepared
      ? session.repositoryId !== request.repositoryId
      : !session.current(request.repositoryId, request.generation))
  )
    return;
  const rangeRevision = session.rangeRevision;
  const rewritesHistory = isHistoryRewrite(action);
  let pause =
    action.kind === 'update-branch' ||
    action.kind === 'cherry-pick-files' ||
    action.kind === 'revert-files'
      ? repositoryRefresh.pause(request.repositoryId)
      : null;

  try {
    const reviewed: Awaited<ReturnType<PanelActions['review']>> = prepared
      ? { action: prepared }
      : await actions.review(action, request);
    const operation = reviewed.action;

    if (!operation) return;
    pause ??= repositoryRefresh.pause(request.repositoryId);
    if (
      operation.kind === 'edit-commit-message' &&
      (!session.current(request.repositoryId, request.generation) ||
        reviewed.context?.aborted)
    )
      throw new Error(
        'The history changed before the commit message could be saved. Select the commit again.',
      );
    const ownsWrite = await beginWrite();
    const result = await adapter.operate(
      request.repositoryId,
      operation,
      reviewed.context,
      progress.git,
    );

    if (
      !closed() &&
      (rewritesHistory || action.kind === 'cherry-pick-commits') &&
      result.kind === 'cancelled'
    )
      await options.reportActionError?.(
        'The history operation was cancelled because the view context changed. The commits were left unchanged.',
      );
    if (rewritesHistory) {
      if (
        closed() ||
        !session.current(request.repositoryId, request.generation) ||
        session.rangeRevision !== rangeRevision ||
        reviewed.context?.aborted
      ) {
        if (result.kind === 'error' || result.kind === 'conflict')
          await options.reportActionError?.(result.message);

        return;
      }

      if (result.kind === 'success' && result.replacementSha)
        session.selection = {
          sha: result.replacementSha,
          parentSha: null,
          filePath: null,
        };
    }

    const current = () =>
      !closed() && session.repositoryId === request.repositoryId;
    const refreshUntilSettled = async (
      owner: OperationProgress,
      owns: () => boolean,
    ) => {
      await owner.refreshing();
      if (!current() || !owns()) return;
      do {
        await refresh();
      } while (
        current() &&
        owns() &&
        repositoryRefresh.hasPending(request.repositoryId)
      );
    };

    const restore =
      result.kind === 'cancelled' ? undefined : result.branchRestore;
    const decision =
      result.kind === 'error' ? result.updateDecision : undefined;
    const updateReported = !!decision && !!options.reportUpdateBlocked;

    if (result.kind === 'error' && decision && options.reportUpdateBlocked) {
      const choices: {
        label: string;
        action: Extract<GitAction, { kind: 'continue-update' }>;
      }[] =
        decision.kind === 'checkout'
          ? [
              {
                label: 'Checkout Branch',
                action: {
                  kind: 'continue-update',
                  method: 'checkout',
                  continuation: decision.continuation,
                },
              },
            ]
          : [
              {
                label: 'Rebase',
                action: {
                  kind: 'continue-update',
                  method: 'rebase',
                  continuation: decision.continuation,
                },
              },
              {
                label: 'Merge',
                action: {
                  kind: 'continue-update',
                  method: 'merge',
                  continuation: decision.continuation,
                },
              },
            ];

      options.reportUpdateBlocked(
        result.message,
        choices.map(({ label, action: next }) => ({
          label,
          run: () =>
            operations.afterCurrent({
              repositoryId: request.repositoryId,
              requestId: `update-recovery:${request.requestId}`,
              key: JSON.stringify(next),
              independent: true,
              description: describeLogAction({
                kind:
                  next.method === 'checkout'
                    ? 'checkout'
                    : next.method === 'merge'
                      ? 'merge-branch'
                      : 'rebase-branch',
                refId:
                  next.method === 'checkout'
                    ? next.continuation.target.refId
                    : next.continuation.target.expectedUpstream,
              }),
              work: async (owner) => {
                if (closed() || !options.trusted()) return;
                const recovering = repositoryRefresh.pause(
                  request.repositoryId,
                );

                try {
                  const owns = await beginWrite();
                  const outcome = await adapter.operate(
                    request.repositoryId,
                    next,
                    undefined,
                    owner.git,
                  );

                  await publishOperationResult(outcome, next.kind, {
                    current: () => current() && owns(),
                    refresh: () => refreshUntilSettled(owner, owns),
                    send: (result) =>
                      send({ kind: 'operation', result }, request.requestId),
                    reportError: options.reportActionError,
                    reportInfo: options.reportActionInfo,
                  });
                } finally {
                  recovering.dispose();
                }
              },
            }),
        })),
      );
    }

    const deletionReported = offerBranchRestore(result, request.repositoryId, {
      ...options,
      adapter,
      current,
      refresh: () => refreshUntilSettled(progress, ownsWrite),
      runRestore: (work) =>
        restore
          ? operations.afterCurrent({
              repositoryId: request.repositoryId,
              requestId: `restore:${restore.token}`,
              independent: true,
              description: {
                label: `Restoring ${restore.name}…`,
                refIds: (restore.names ?? [restore.name]).map(
                  (name) => `refs/heads/${name}`,
                ),
              },
              work: async (owner) => {
                if (closed()) return;
                const restoring = repositoryRefresh.pause(request.repositoryId);

                try {
                  const owns = await beginWrite();

                  await work(() => refreshUntilSettled(owner, owns), owner.git);
                } finally {
                  restoring.dispose();
                }
              },
            })
          : Promise.resolve(),
    });

    await publishOperationResult(result, action.kind, {
      current: () => current() && ownsWrite(),
      refresh: () => refreshUntilSettled(progress, ownsWrite),
      send: (result) => send({ kind: 'operation', result }, request.requestId),
      reportError:
        deletionReported || updateReported
          ? undefined
          : options.reportActionError,
      reportInfo: deletionReported ? undefined : options.reportActionInfo,
      revealSourceControl: options.revealSourceControl,
    });
  } finally {
    pause?.dispose();
  }
}
