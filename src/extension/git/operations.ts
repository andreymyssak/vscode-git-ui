import { extensionIdentity } from '../../shared/extension-identity';
import type {
  BranchRestoreHandle,
  GitAction,
  OperationResult,
  Reference,
} from '../../shared/model';
import type { GitApiAccess } from './api';
import { deleteBranch, deleteBranches } from './branch-deletion';
import { integrateBranch } from './branch-integration';
import { BranchRestores } from './branch-restore';
import type { UpdateBranchDialogs } from './branch-update';
import { updateBranch } from './branch-update';
import { cherryPickCommits } from './cherry-pick';
import type { GitCli } from './cli';
import { dropCommits } from './drop-commits';
import { editCommitMessage } from './message-edit';
import { GitPartialCompletion } from './partial-completion';
import { readReferences } from './resolve';
import type { SquashServices } from './squash-operation';
import { runSquash } from './squash-operation';
import {
  GitRequiresSourceControl,
  requireNoGitOperation,
} from './working-tree-state';
import { createBranchWorktree } from './worktree-create';
import { deleteWorktrees } from './worktrees';

export type { SquashServices } from './squash-operation';
export interface OperationDialogs extends UpdateBranchDialogs {
  remoteCheckout(
    ref: Reference,
    locals: Reference[],
  ): Promise<
    | { kind: 'existing'; refId: string; expectedSha: string }
    | { kind: 'create'; name: string }
    | null
  >;
}
export class OperationQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);

    this.tails.set(id, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(id) === next) this.tails.delete(id);
    }
  }
}
export const repositoryOperations = new OperationQueue();

export function createOperations(
  access: GitApiAccess,
  cli: Pick<GitCli, 'run'>,
  dialogs: OperationDialogs,
  squash?: SquashServices,
): (
  id: string,
  action: GitAction,
  context?: AbortSignal,
) => Promise<OperationResult> {
  const restores = new BranchRestores(access, cli);

  return (id, requested, context) => {
    const action =
      requested.kind === 'delete-worktrees'
        ? {
            ...requested,
            worktrees: requested.worktrees.map((item) => ({ ...item })),
          }
        : requested.kind === 'delete-branches'
          ? {
              ...requested,
              branches: requested.branches.map((branch) => ({ ...branch })),
            }
          : 'target' in requested
            ? {
                ...requested,
                target: {
                  ...requested.target,
                  shas: [...requested.target.shas],
                },
              }
            : requested;

    return repositoryOperations.run<OperationResult>(id, async () => {
      if (context?.aborted) return { kind: 'cancelled', backend: null };
      let backend: 'api' | 'cli' = [
        'cherry-pick',
        'cherry-pick-commits',
        'edit-commit-message',
        'squash-commits',
        'drop-commits',
        'delete-worktrees',
      ].includes(action.kind)
        ? 'cli'
        : 'api';
      let message: string | undefined;
      let branchRestore: BranchRestoreHandle | undefined;
      const reference = async (
        refId: string,
        expected: string,
      ): Promise<Reference> => {
        const ref = (await readReferences(access, id)).find(
          (ref) => ref.id === refId,
        );

        if (!ref || ref.sha !== expected)
          throw new Error(
            'The selected reference changed. Refresh and select it again.',
          );

        return ref;
      };

      const branchName = async (name: string) => {
        if (!name || name.startsWith('-'))
          throw new Error(
            'Branch names beginning with an option character are unavailable for this operation.',
          );
        await cli.run(id, ['check-ref-format', '--branch', name]);
      };

      try {
        let repo = access.repository(id);
        let replacementSha: string | undefined;

        switch (action.kind) {
          case 'delete-worktrees':
            return await deleteWorktrees(
              access,
              cli,
              id,
              action.worktrees,
              context,
            );
          case 'delete-branches':
            return await deleteBranches(
              access,
              cli,
              restores,
              id,
              action.branches,
              context,
            );
          case 'drop-commits':
            replacementSha = await dropCommits(
              access,
              cli,
              id,
              action.target,
              context,
            );
            message = `Dropped ${action.target.shas.length} commit${action.target.shas.length === 1 ? '' : 's'} from "${action.target.expectedBranch}".`;
            break;
          case 'branch-from-commit':
          case 'tag-from-commit': {
            if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(action.sha))
              throw new Error('Select a full commit identity.');
            if ((await repo.getCommit(action.sha)).hash !== action.sha)
              throw new Error('The selected commit is unavailable.');
            if (!action.name || action.name.startsWith('-'))
              throw new Error(
                'Enter a reference name without an initial option character.',
              );
            await cli.run(id, [
              'check-ref-format',
              `${action.kind === 'branch-from-commit' ? 'refs/heads' : 'refs/tags'}/${action.name}`,
            ]);
            context?.throwIfAborted();
            repo = access.repository(id);
            if (action.kind === 'branch-from-commit')
              await repo.createBranch(action.name, false, action.sha);
            else await repo.tag(action.name, '', action.sha);
            message = `Created ${action.kind === 'branch-from-commit' ? 'branch' : 'tag'} "${action.name}".`;
            break;
          }

          case 'create-worktree':
            message = await createBranchWorktree(
              repo,
              cli,
              id,
              action,
              () => reference(action.refId, action.expectedSha),
              context,
            );
            break;
          case 'merge-branch':
          case 'rebase-branch':
            message = await integrateBranch(
              repo,
              cli,
              id,
              action,
              () => reference(action.refId, action.expectedSha),
              context,
            );
            break;
          case 'squash-commits':
            replacementSha = await runSquash(
              access,
              cli,
              id,
              action.target,
              action.message,
              squash,
              context,
            );
            break;
          case 'edit-commit-message':
            replacementSha = await editCommitMessage(
              access,
              cli,
              id,
              action,
              squash,
              context,
            );
            message = 'Commit message updated.';
            break;

          case 'update-branch': {
            backend = 'cli';
            const result = await updateBranch(
              repo,
              cli,
              id,
              action,
              dialogs,
              context,
              (chosen) => {
                backend = chosen;
              },
            );

            if (result === null) {
              await access.repository(id).status();

              return { kind: 'cancelled', backend: null };
            }

            backend = result.backend;
            message = result.message;
            break;
          }

          case 'fetch-all':
            await repo.fetch({ all: true });
            break;
          case 'create-branch': {
            await branchName(action.name);
            await reference(action.refId, action.expectedSha);
            repo = access.repository(id);
            await repo.createBranch(action.name, false, action.expectedSha);
            break;
          }

          case 'rename-branch': {
            const ref = await reference(action.refId, action.expectedSha);

            if (ref.kind !== 'local')
              throw new Error('Rename requires a local branch.');
            await branchName(action.name);
            await reference(ref.id, ref.sha);
            backend = 'cli';
            await cli.run(id, ['branch', '-m', '--', ref.name, action.name]);
            break;
          }

          case 'restore-branch':
            message = await restores.restore(id, action.token, context);
            break;

          case 'delete-branch': {
            const deleted = await deleteBranch(
              access,
              cli,
              restores,
              id,
              action,
              context,
            );

            backend = deleted.backend;
            branchRestore = restores.remember(deleted.record);
            message = `Deleted branch "${deleted.record.name}".`;
            break;
          }

          case 'checkout': {
            const ref = await reference(action.refId, action.expectedSha);

            if (ref.kind === 'tag')
              throw new Error('Checkout requires a branch.');
            if (ref.kind === 'local') {
              if (ref.name.startsWith('-')) {
                await reference(ref.id, ref.sha);
                backend = 'cli';
                await cli.run(id, ['switch', '--no-guess', '--', ref.name]);
              } else {
                await branchName(ref.name);
                await reference(ref.id, ref.sha);
                await access.repository(id).checkout(ref.name);
              }

              break;
            }

            const candidates = (await readReferences(access, id)).filter(
              (item) => item.kind === 'local',
            );
            const locals: Reference[] = [];

            for (const candidate of candidates) {
              const branch = await repo.getBranch(candidate.id);
              const upstream = branch.upstream;

              if (
                upstream &&
                (upstream.name === ref.name ||
                  `${upstream.remote}/${upstream.name}` === ref.name)
              )
                locals.push(candidate);
            }

            const choice = await dialogs.remoteCheckout(ref, locals);

            if (!choice) return { kind: 'cancelled', backend: null };
            await reference(ref.id, ref.sha);
            if (choice.kind === 'existing') {
              if (
                !locals.some(
                  (local) =>
                    local.id === choice.refId &&
                    local.sha === choice.expectedSha,
                )
              )
                throw new Error('Choose an offered tracking branch.');
              const local = await reference(choice.refId, choice.expectedSha);

              await branchName(local.name);
              await access.repository(id).checkout(local.name);
            } else {
              await branchName(choice.name);
              await reference(ref.id, ref.sha);
              await access
                .repository(id)
                .createBranch(choice.name, false, ref.sha);
              let failed = `Tracking to "${ref.name}" could not be set.`;

              try {
                await reference(ref.id, ref.sha);
                await access
                  .repository(id)
                  .setBranchUpstream(choice.name, ref.name);
                failed = 'Checkout did not finish successfully.';
                await reference(`refs/heads/${choice.name}`, ref.sha);
                await access.repository(id).checkout(choice.name);
              } catch (error) {
                throw new GitPartialCompletion(
                  `Created branch "${choice.name}".`,
                  failed,
                  error,
                );
              }
            }

            break;
          }

          case 'cherry-pick':
          case 'cherry-pick-commits':
            await cherryPickCommits(
              access,
              cli,
              id,
              action.kind === 'cherry-pick'
                ? {
                    shas: [action.sha],
                    expectedHeadSha: action.expectedHeadSha,
                    expectedBranch: action.expectedBranch,
                  }
                : action.target,
              context,
            );
            break;
          default: {
            const exhaustive: never = action;

            void exhaustive;
          }
        }

        await access.repository(id).status();

        return {
          kind: 'success',
          backend,
          ...(replacementSha ? { replacementSha } : {}),
          ...(branchRestore ? { branchRestore } : {}),
          ...(message ? { message } : {}),
        };
      } catch (error) {
        if (branchRestore)
          return {
            kind: 'success',
            backend,
            branchRestore,
            message: `${message} ${extensionIdentity.displayName} could not refresh. Use Refresh to reload it.`,
          };
        if (context?.aborted && error === context.reason)
          return { kind: 'cancelled', backend: null };
        if (action.kind === 'delete-worktrees')
          return {
            kind: 'error',
            backend: 'cli',
            message: error instanceof Error ? error.message : String(error),
          };
        let conflict = false;
        let unfinished = false;

        try {
          conflict =
            (
              await cli.run(id, [
                'diff',
                '--name-only',
                '--diff-filter=U',
                '-z',
              ])
            ).length > 0;
          await access.repository(id).status();
        } catch {
          /* Keep the original write result when refresh also fails. */
        }

        if (
          action.kind === 'squash-commits' ||
          action.kind === 'edit-commit-message'
        ) {
          try {
            await requireNoGitOperation(cli, id, 'editing history');
          } catch (state) {
            unfinished = state instanceof GitRequiresSourceControl;
          }
        }

        return {
          kind: conflict ? 'conflict' : 'error',
          backend,
          ...(conflict ||
          unfinished ||
          error instanceof GitRequiresSourceControl ||
          (error instanceof Error &&
            error.cause instanceof GitRequiresSourceControl)
            ? { recovery: 'source-control' as const }
            : {}),
          message:
            error instanceof GitPartialCompletion
              ? error.message
              : conflict
                ? action.kind === 'cherry-pick-commits'
                  ? 'Git found conflicts. Resolve and stage them in Source Control, then run git cherry-pick --continue in the terminal. Git: Abort Cherry-Pick cancels the sequence.'
                  : 'Git found conflicts. Resolve them in Source Control.'
                : [
                      'update-branch',
                      'merge-branch',
                      'rebase-branch',
                      'create-worktree',
                      'branch-from-commit',
                      'tag-from-commit',
                      'cherry-pick',
                      'cherry-pick-commits',
                      'drop-commits',
                      'edit-commit-message',
                      'squash-commits',
                      'delete-branch',
                      'delete-branches',
                      'delete-worktrees',
                      'restore-branch',
                    ].includes(action.kind)
                  ? error instanceof Error
                    ? error.message
                    : String(error)
                  : `${error instanceof Error ? error.message : String(error)} Refresh before retrying; the operation was not retried.`,
        };
      }
    });
  };
}
