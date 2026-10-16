import type { FileIconThemeMessage } from './file-icons';
import type {
  CommitRecord,
  FileChange,
  HistoryEnrichment,
  HistoryFilters,
  HistoryPage,
  OperationResult,
  Reference,
  RepositoryInfo,
  Scope,
  ScrollAnchor,
  Selection,
  WorktreeInfo,
} from './model';

export interface Request<T> {
  requestId: string;
  repositoryId: string;
  generation: number;
  body: T;
}
export interface Result<T> {
  requestId: string;
  repositoryId: string;
  generation: number;
  body: T;
}
export interface ActiveLogOperation {
  requestId: string;
  label: string;
  refIds: string[];
  phase: 'waiting' | 'running' | 'refreshing';
  section?: 'branches' | 'history' | 'worktrees';
  queued?: Pick<ActiveLogOperation, 'label' | 'refIds' | 'section'>[];
}
export type SetupState =
  'ready' | 'no-repository' | 'git-disabled' | 'untrusted';
export type BranchActionKind =
  | 'update-branch'
  | 'merge-branch'
  | 'rebase-branch'
  | 'create-worktree'
  | 'checkout'
  | 'create-branch'
  | 'create-branch-checkout'
  | 'copy-branch'
  | 'rename-branch'
  | 'delete-branch'
  | 'delete-branches';
export type CommitActionKind =
  | 'copy-sha'
  | 'cherry-pick'
  | 'cherry-pick-files'
  | 'revert-files'
  | 'edit-commit-message'
  | 'squash-commits'
  | 'branch-from-commit'
  | 'tag-from-commit'
  | 'drop-commits';
export type WorktreeActionKind =
  'open-worktree-new' | 'open-worktree-current' | 'delete-worktrees';
export type UserAction =
  | { kind: 'delete-worktrees'; worktreeIds: string[] }
  | {
      kind: Exclude<BranchActionKind, 'delete-branches' | 'create-worktree'>;
      refId: string;
    }
  | { kind: 'create-worktree'; refId?: string }
  | { kind: 'delete-branches'; refIds: string[] }
  | { kind: 'copy-sha'; sha: string }
  | { kind: 'cherry-pick'; sha: string }
  | { kind: 'cherry-pick-files'; fileIds: string[] }
  | { kind: 'revert-files'; fileIds: string[] }
  | { kind: 'edit-commit-message'; sha: string }
  | { kind: 'branch-from-commit'; sha: string }
  | { kind: 'tag-from-commit'; sha: string }
  | { kind: 'squash-commits'; shas: string[]; activeSha: string }
  | {
      kind: 'cherry-pick-commits';
      shas: string[];
      activeSha: string;
    }
  | { kind: 'drop-commits'; shas: string[]; activeSha: string }
  | { kind: 'fetch-all' };
export type RequestBody =
  | { kind: 'ready'; savedRepositoryId: string | null }
  | { kind: 'choose-repository' }
  | {
      kind: 'history';
      scope: Scope;
      text: string;
      cursor: string | null;
      filters?: HistoryFilters;
    }
  | { kind: 'choose-authors' }
  | { kind: 'invalid-date-filter' }
  | { kind: 'select-commit'; sha: string }
  | { kind: 'select-commits'; shas: string[]; activeSha: string }
  | { kind: 'load-parent'; sha: string; parentSha: string | null }
  | { kind: 'open-file'; fileId: string; preview: boolean }
  | { kind: 'go-to'; input: string }
  | { kind: 'action'; action: UserAction }
  | { kind: 'worktrees'; retry?: true }
  | { kind: 'open-worktree'; worktreeId: string; newWindow: boolean }
  | {
      kind: 'restore';
      scope: Scope;
      text: string;
      filters?: HistoryFilters;
      selection: Selection | null;
      anchor: ScrollAnchor | null;
    }
  | { kind: 'anchor'; anchor: ScrollAnchor | null }
  | { kind: 'refresh' }
  | { kind: 'source-control' }
  | { kind: 'trust' };
/** Omitted refs retain the authoritative snapshot in this repository generation. */
export type HistoryPageUpdate = Omit<HistoryPage, 'refs'> & {
  refs?: Reference[];
};
export type HistoryEnrichmentUpdate = Omit<HistoryEnrichment, 'refs'> & {
  refs?: Reference[];
};
export type PanelBody =
  | FileIconThemeMessage
  | { kind: 'filters'; filters: HistoryFilters }
  | { kind: 'reveal'; sha: string }
  | { kind: 'focus-log' }
  | {
      kind: 'selection';
      sha: string | null;
      parentSha: string | null;
      filePath: string | null;
      anchor: ScrollAnchor | null;
    }
  | { kind: 'notice'; message: string }
  | {
      kind: 'setup';
      state: SetupState;
      message: string;
      repositories: RepositoryInfo[];
    }
  | {
      kind: 'loading';
      scope: Scope;
      text: string;
      repository: RepositoryInfo;
      preserve?: boolean;
      filters?: HistoryFilters;
    }
  | {
      kind: 'history';
      page: HistoryPageUpdate;
      append: boolean;
      scope: Scope;
      text: string;
      repository: RepositoryInfo;
      filters?: HistoryFilters;
      restoring?: boolean;
    }
  | { kind: 'history-settled' }
  | { kind: 'history-enrichment'; enrichment: HistoryEnrichmentUpdate }
  | { kind: 'history-interrupted' }
  | { kind: 'details'; commit: CommitRecord }
  | {
      kind: 'files';
      sha: string;
      parentSha: string | null;
      files: FileChange[];
    }
  | {
      kind: 'files-error';
      sha: string;
      parentSha: string | null;
      message: string;
    }
  | { kind: 'worktrees'; worktrees: WorktreeInfo[] }
  | { kind: 'worktrees-loading'; loading: boolean }
  | { kind: 'worktrees-error'; message: string }
  | { kind: 'operation'; result: OperationResult }
  | {
      kind: 'operation-progress';
      operation: Omit<ActiveLogOperation, 'requestId'> | null;
    }
  | { kind: 'error'; message: string }
  | {
      kind: 'references';
      references: Reference[];
      repository?: RepositoryInfo;
    };
