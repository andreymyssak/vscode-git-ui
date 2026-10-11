import type { FileIconThemeMessage } from './file-icons';
import type {
  CommitRecord,
  FileChange,
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
export type SetupState =
  'ready' | 'no-repository' | 'git-disabled' | 'untrusted';
export type BranchActionKind =
  | 'update-branch'
  | 'merge-branch'
  | 'rebase-branch'
  | 'create-worktree'
  | 'checkout'
  | 'create-branch'
  | 'copy-branch'
  | 'rename-branch'
  | 'delete-branch'
  | 'delete-branches';
export type CommitActionKind =
  | 'copy-sha'
  | 'cherry-pick'
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
export type PanelBody =
  | FileIconThemeMessage
  | { kind: 'filters'; filters: HistoryFilters }
  | { kind: 'reveal'; sha: string }
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
      page: HistoryPage;
      append: boolean;
      scope: Scope;
      text: string;
      repository: RepositoryInfo;
      filters?: HistoryFilters;
      restoring?: boolean;
    }
  | { kind: 'history-settled' }
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
  | { kind: 'operation'; result: OperationResult }
  | { kind: 'error'; message: string }
  | { kind: 'references'; references: Reference[] };
