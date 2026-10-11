import { isBranchDeletionSelection } from '../../shared/branch-selection';
import { extensionIdentity } from '../../shared/extension-identity';
import type { Request, RequestBody, UserAction } from '../../shared/messages';
import type {
  GitAction,
  OperationResult,
  WorktreeInfo,
} from '../../shared/model';
import {
  canDeleteWorktree,
  isWorktreeSelection,
} from '../../shared/worktree-selection';
import type { GitAdapter } from '../git/adapter';
import { captureCommitRange } from './commit-range';
import type { QuerySession } from './queries';
import { reviewSquash } from './squash';
import { prepareNewWorktree, type WorktreeCreationPrompts } from './worktrees';

export interface ActionPrompts extends WorktreeCreationPrompts {
  confirmWorktreeDeletion?: (
    worktrees: readonly WorktreeInfo[],
  ) => Promise<boolean>;
  confirmBranchIntegration?: (
    kind: 'merge-branch' | 'rebase-branch',
    current: string,
    selected: string,
  ) => Promise<boolean>;
  askBranchName?: () => Promise<string | null>;
  askTagName?: () => Promise<string | null>;
  confirmDrop?: (branch: string, count: number) => Promise<boolean>;
  askRenameBranch?: (name: string) => Promise<string | null>;
  askCommitMessage?: (message: string) => Promise<string | null>;
  copyText?: (text: string) => Promise<void>;
  askSquashMessage?: (
    message: string,
    branch: string,
    count: number,
  ) => Promise<string | null>;
  reportActionError?: (
    message: string,
    sourceControl?: boolean,
  ) => Promise<void>;
  reportBranchDeleted?: (
    name: string,
    restore: () => Promise<void>,
    names?: readonly string[],
    failure?: string,
  ) => void;
  reportActionInfo?: (message: string) => void | Promise<void>;
}

export function isHistoryRewrite(action: GitAction | UserAction): boolean {
  return (
    action.kind === 'edit-commit-message' ||
    action.kind === 'squash-commits' ||
    action.kind === 'drop-commits'
  );
}

/** Report Update outcomes immediately, independently of the panel's refresh. */
export async function publishOperationResult(
  result: OperationResult,
  kind: UserAction['kind'],
  lifecycle: {
    current(): boolean;
    refresh(): Promise<void>;
    send(result: OperationResult): Promise<void>;
    reportError:
      ((message: string, sourceControl?: boolean) => Promise<void>) | undefined;
    reportInfo?: ((message: string) => void | Promise<void>) | undefined;
  },
): Promise<void> {
  const nativeResult = [
    'delete-worktrees',
    'update-branch',
    'merge-branch',
    'rebase-branch',
    'create-worktree',
    'branch-from-commit',
    'tag-from-commit',
    'cherry-pick',
    'cherry-pick-commits',
    'drop-commits',
    'squash-commits',
    'edit-commit-message',
    'delete-branches',
  ].includes(kind);

  await Promise.all([
    result.kind === 'error' || result.kind === 'conflict'
      ? lifecycle.reportError?.(
          result.message,
          result.kind === 'conflict' || result.recovery === 'source-control',
        )
      : nativeResult && result.kind === 'success' && result.message
        ? lifecycle.reportInfo?.(result.message)
        : undefined,
    (async () => {
      if (!lifecycle.current()) return;
      await lifecycle.refresh();
      if (lifecycle.current()) await lifecycle.send(result);
    })(),
  ]);
}

type ActionRequest = Pick<Request<unknown>, 'repositoryId' | 'generation'>;

/** Converts displayed identities and native prompt answers into a write target. */
export class PanelActions {
  constructor(
    private readonly adapter: GitAdapter,
    private readonly session: QuerySession,
    private readonly prompts: ActionPrompts,
  ) {}

  async review(
    action: UserAction,
    request: Request<RequestBody>,
  ): Promise<{ action: GitAction | null; context?: AbortSignal }> {
    if (action.kind === 'delete-worktrees') {
      if (!isWorktreeSelection(action.worktreeIds))
        throw new Error('Select worktrees from the current list.');
      const targets = action.worktreeIds.map((id) => {
        const item = this.session.worktrees.get(id);

        if (!item || !canDeleteWorktree(item))
          throw new Error(
            'Select worktrees other than the current, main or locked worktree.',
          );

        return { ...item };
      });
      const context = this.session.abort.signal;

      if (!(await this.prompts.confirmWorktreeDeletion?.(targets)))
        return { action: null };
      if (
        !this.session.current(request.repositoryId, request.generation) ||
        context.aborted
      )
        return { action: null };

      return {
        action: { kind: 'delete-worktrees', worktrees: targets },
        context,
      };
    }

    if (action.kind === 'drop-commits') {
      const captured = captureCommitRange(
        this.session,
        request,
        action.shas,
        action.activeSha,
      );

      await this.adapter.prepareDrop(request.repositoryId, captured.target);
      if (!captured.current())
        throw new Error(
          'The selection changed before Drop confirmation. Select the commits again.',
        );
      if (
        !(await this.prompts.confirmDrop?.(
          captured.target.expectedBranch,
          captured.target.shas.length,
        ))
      )
        return { action: null };
      if (!captured.current())
        throw new Error(
          'The selection changed during Drop confirmation. Select the commits again.',
        );

      return {
        action: { kind: 'drop-commits', target: captured.target },
        context: captured.context,
      };
    }

    if (action.kind === 'cherry-pick-commits') {
      const captured = captureCommitRange(
        this.session,
        request,
        action.shas,
        action.activeSha,
      );
      const selected = new Set(action.shas);
      const ordered = this.session.historyShas
        .filter((sha) => selected.has(sha))
        .reverse();

      if (
        ordered.length !== selected.size ||
        ordered.some((sha) => this.session.commits.get(sha)!.parents.length > 1)
      )
        throw new Error('Select loaded ordinary commits for cherry-picking.');

      return {
        action: {
          kind: 'cherry-pick-commits',
          target: { ...captured.target, shas: ordered },
        },
        context: captured.context,
      };
    }

    if (action.kind === 'squash-commits')
      return (
        (await reviewSquash({
          adapter: this.adapter,
          session: this.session,
          request,
          shas: action.shas,
          activeSha: action.activeSha,
          askMessage:
            this.prompts.askSquashMessage ?? (() => Promise.resolve(null)),
        })) ?? { action: null }
      );
    const context = AbortSignal.any([
      this.session.abort.signal,
      this.session.rangeAbort.signal,
    ]);
    const prepared = await this.prepare(action, request);

    return {
      action: prepared,
      ...([
        'edit-commit-message',
        'cherry-pick',
        'merge-branch',
        'rebase-branch',
        'create-worktree',
        'branch-from-commit',
        'tag-from-commit',
      ].includes(action.kind)
        ? { context }
        : {}),
    };
  }

  async prepare(
    action: UserAction,
    request: ActionRequest,
  ): Promise<GitAction | null> {
    if (action.kind === 'delete-branches') {
      if (!isBranchDeletionSelection(action.refIds))
        throw new Error('Select between 2 and 400 distinct local branches.');
      const branches = action.refIds.map((refId) => {
        const ref = this.session.refs.get(refId);

        if (
          !ref ||
          ref.kind !== 'local' ||
          ref.name === this.session.repositoryInfo?.branch
        )
          throw new Error(
            'Select local branches other than the current branch.',
          );

        return { refId: ref.id, expectedSha: ref.sha };
      });

      return { kind: 'delete-branches', branches };
    }

    if (
      action.kind === 'delete-worktrees' ||
      action.kind === 'squash-commits' ||
      action.kind === 'cherry-pick-commits' ||
      action.kind === 'drop-commits'
    )
      throw new Error('This action requires a reviewed commit range.');
    const singleCommitAction =
      action.kind === 'copy-sha' ||
      action.kind === 'cherry-pick' ||
      action.kind === 'branch-from-commit' ||
      action.kind === 'tag-from-commit' ||
      action.kind === 'edit-commit-message';

    if (singleCommitAction && this.session.selectedShas.length > 1)
      throw new Error('Select one commit for this single-commit action.');
    if (action.kind === 'copy-sha') {
      if (!this.session.commits.has(action.sha))
        throw new Error('Select a commit from the current history.');
      await this.prompts.copyText?.(action.sha);

      return null;
    }

    if (action.kind === 'fetch-all') return { kind: 'fetch-all' };
    if (
      action.kind === 'branch-from-commit' ||
      action.kind === 'tag-from-commit'
    ) {
      if (
        !this.session.commits.has(action.sha) ||
        this.session.selectedSha !== action.sha ||
        this.session.selectedShas.length !== 1
      )
        throw new Error('Select a commit from the current history.');
      const name =
        action.kind === 'branch-from-commit'
          ? await this.prompts.askBranchName?.()
          : await this.prompts.askTagName?.();

      if (name === null || name === undefined) return null;
      if (!this.session.current(request.repositoryId, request.generation))
        throw new Error(
          'The history changed. Select the commit and action again.',
        );

      return { kind: action.kind, sha: action.sha, name };
    }

    if (action.kind === 'edit-commit-message') {
      const commit = this.session.commits.get(action.sha);
      const repo = this.session.repositoryInfo;

      if (!commit || !repo?.branch || !repo.headSha)
        throw new Error(
          'Select a commit on the checked-out branch to edit its message.',
        );
      if (
        [...this.session.refs.values()].some(
          (ref) => ref.kind === 'remote' && ref.sha === action.sha,
        )
      )
        throw new Error(
          'This commit is in known remote history. Editing published commits is not included yet.',
        );

      await this.adapter.prepareMessageEdit(
        request.repositoryId,
        action.sha,
        repo.branch,
        repo.headSha,
      );
      if (!this.session.current(request.repositoryId, request.generation))
        throw new Error(
          'The history changed before the message editor opened. Select the commit again.',
        );
      const message = await this.prompts.askCommitMessage?.(commit.message);

      if (
        message === null ||
        message === undefined ||
        message === commit.message
      )
        return null;
      if (!this.session.current(request.repositoryId, request.generation))
        throw new Error(
          'The history changed while the message editor was open. Select the commit again.',
        );

      return {
        kind: 'edit-commit-message',
        sha: action.sha,
        expectedBranch: repo.branch,
        expectedHeadSha: repo.headSha,
        message,
      };
    }

    if (action.kind === 'cherry-pick') {
      const commit = this.session.commits.get(action.sha);
      const repo = this.session.repositoryInfo;

      if (
        !commit ||
        commit.parents.length > 1 ||
        !repo?.headSha ||
        !repo.branch
      )
        throw new Error(
          'Select an ordinary commit and check out a target branch.',
        );

      return {
        kind: 'cherry-pick',
        sha: action.sha,
        expectedHeadSha: repo.headSha,
        expectedBranch: repo.branch,
      };
    }

    if (action.kind === 'create-worktree')
      return prepareNewWorktree(
        this.adapter,
        this.session,
        request,
        action.refId,
        this.prompts,
      );

    const ref = this.session.refs.get(action.refId);

    if (!ref) throw new Error('Select a reference from the current history.');
    if (action.kind === 'merge-branch' || action.kind === 'rebase-branch') {
      const repo = this.session.repositoryInfo;

      if (
        !repo?.branch ||
        !repo.headSha ||
        ref.kind === 'tag' ||
        ref.id === `refs/heads/${repo.branch}`
      )
        throw new Error(
          'Check out a branch and select another local or remote branch.',
        );
      if (
        !(await this.prompts.confirmBranchIntegration?.(
          action.kind,
          repo.branch,
          ref.name,
        ))
      )
        return null;
      if (!this.session.current(request.repositoryId, request.generation))
        throw new Error(
          `The ${extensionIdentity.displayName} view changed. Select the branch and action again.`,
        );

      return {
        kind: action.kind,
        refId: ref.id,
        expectedSha: ref.sha,
        expectedBranch: repo.branch,
        expectedHeadSha: repo.headSha,
      };
    }

    if (action.kind === 'update-branch') {
      if (ref.kind !== 'local' || !ref.tracking || ref.tracking.behind === null)
        throw new Error(
          'Select a local branch with an available tracked upstream before updating.',
        );

      return {
        kind: 'update-branch',
        refId: ref.id,
        expectedSha: ref.sha,
        expectedUpstream: ref.tracking.upstream,
      };
    }

    if (action.kind === 'copy-branch') {
      await this.prompts.copyText?.(ref.name);

      return null;
    }

    if (action.kind === 'rename-branch' || action.kind === 'delete-branch') {
      if (ref.kind !== 'local')
        throw new Error('Select a local branch for this operation.');
      if (
        action.kind === 'delete-branch' &&
        ref.name === this.session.repositoryInfo?.branch
      )
        throw new Error(
          'The current branch cannot be deleted. Check out another branch first.',
        );
    }

    if (action.kind === 'create-branch' || action.kind === 'rename-branch') {
      const name =
        action.kind === 'create-branch'
          ? await this.prompts.askBranchName?.()
          : await this.prompts.askRenameBranch?.(ref.name);

      if (name === null || name === undefined) return null;

      return { kind: action.kind, refId: ref.id, expectedSha: ref.sha, name };
    }

    if (action.kind === 'delete-branch')
      return { kind: 'delete-branch', refId: ref.id, expectedSha: ref.sha };

    return { kind: 'checkout', refId: ref.id, expectedSha: ref.sha };
  }
}

export function offerBranchRestore(
  result: OperationResult,
  repositoryId: string,
  options: Pick<
    ActionPrompts,
    'reportBranchDeleted' | 'reportActionError' | 'reportActionInfo'
  > & {
    adapter: GitAdapter;
    trusted(): boolean;
    current(): boolean;
    refresh(): Promise<void>;
  },
): boolean {
  if (
    result.kind === 'cancelled' ||
    !result.branchRestore ||
    !options.reportBranchDeleted
  )
    return false;
  const { name, names, token } = result.branchRestore;

  options.reportBranchDeleted?.(
    name,
    async () => {
      if (!options.trusted()) {
        await options.reportActionError?.(
          'Trust this workspace before restoring a branch.',
        );

        return;
      }

      const restored = await options.adapter.operate(repositoryId, {
        kind: 'restore-branch',
        token,
      });

      if (restored.kind === 'error' || restored.kind === 'conflict')
        await options.reportActionError?.(restored.message);
      else if (restored.kind === 'success' && restored.message)
        await options.reportActionInfo?.(restored.message);
      if (options.current()) await options.refresh();
    },
    names,
    result.kind === 'error' || result.kind === 'conflict'
      ? result.message
      : undefined,
  );

  return true;
}
