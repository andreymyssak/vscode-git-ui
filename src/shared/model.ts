export type Scope =
  | { kind: 'head' }
  | { kind: 'all' }
  | { kind: 'ref'; refId: string }
  | { kind: 'commit'; sha: string };
export interface RepositoryInfo {
  id: string;
  label: string;
  rootUri: string;
  headSha: string | null;
  branch: string | null;
}
export interface Reference {
  id: string;
  name: string;
  kind: 'local' | 'remote' | 'tag';
  sha: string;
  remote: string | null;
  tracking?: { upstream: string; ahead: number | null; behind: number | null };
}
export interface CommitRecord {
  sha: string;
  parents: string[];
  message: string;
  authorName: string | null;
  authorEmail: string | null;
  authorDate: string | null;
  commitDate: string | null;
}
export interface AuthorIdentity {
  name: string;
  email: string;
}
export type DateFilter =
  | 'all'
  | '24h'
  | '7d'
  | { kind: 'range'; from: string | null; to: string | null };
export interface HistoryFilters {
  regex: boolean;
  matchCase: boolean;
  author:
    | { kind: 'all' }
    | { kind: 'me' }
    | { kind: 'selected'; identities: AuthorIdentity[] };
  date: DateFilter;
}
export interface HistoryInput {
  scope: Scope;
  text: string;
  cursor: string | null;
  filters?: HistoryFilters;
}
export interface HistoryPage {
  commits: CommitRecord[];
  refs: Reference[];
  nextCursor: string | null;
  scopeId: string;
  annotations?: HistoryAnnotations;
}
export interface HistoryAnnotations {
  user: AuthorIdentity | null;
  currentBranch: string[];
}
export interface HistoryPresentation {
  showAuthor: boolean;
  showDate: boolean;
  highlightMyCommits: boolean;
  highlightMergeCommits: boolean;
  highlightCurrentBranch: boolean;
}
export interface FileChange {
  id: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath: string | null;
  newPath: string | null;
}
export interface WorktreeInfo {
  id: string;
  name: string;
  rootUri: string;
  branch: string | null;
  current: boolean;
  available: boolean;
  main?: boolean;
  locked?: boolean;
  deletionBlocked?: string;
}
export type ResolveResult =
  | { kind: 'commit'; commit: CommitRecord }
  | { kind: 'choices'; references: Reference[] }
  | { kind: 'ambiguous' | 'missing'; message: string };
export type Backend = 'api' | 'command' | 'cli';
export type GitAction =
  | {
      kind: 'delete-worktrees';
      worktrees: readonly Pick<WorktreeInfo, 'id' | 'rootUri'>[];
    }
  | {
      kind: 'branch-from-commit' | 'tag-from-commit';
      sha: string;
      name: string;
    }
  | { kind: 'checkout'; refId: string; expectedSha: string }
  | {
      kind: 'create-branch' | 'create-branch-checkout';
      refId: string;
      expectedSha: string;
      name: string;
    }
  | { kind: 'rename-branch'; refId: string; expectedSha: string; name: string }
  | { kind: 'delete-branch'; refId: string; expectedSha: string }
  | { kind: 'delete-branches'; branches: readonly BranchDeletionTarget[] }
  | { kind: 'restore-branch'; token: string }
  | {
      kind: 'create-worktree';
      refId: string;
      expectedSha: string;
      path: string;
      name: string | null;
    }
  | {
      kind: 'merge-branch' | 'rebase-branch';
      refId: string;
      expectedSha: string;
      expectedBranch: string;
      expectedHeadSha: string;
    }
  | {
      kind: 'update-branch';
      refId: string;
      expectedSha: string;
      expectedUpstream: string;
    }
  | {
      kind: 'continue-update';
      method: 'checkout' | 'merge' | 'rebase';
      continuation: BranchUpdateContinuation;
    }
  | { kind: 'fetch-all' }
  | {
      kind: 'edit-commit-message';
      expectedHeadSha: string;
      sha: string;
      expectedBranch: string;
      message: string;
    }
  | {
      kind: 'cherry-pick';
      sha: string;
      expectedHeadSha: string;
      expectedBranch: string;
    }
  | {
      kind: 'cherry-pick-files' | 'revert-files';
      sha: string;
      parentSha: string | null;
      files: readonly FileChange[];
      expectedHeadSha: string;
      expectedBranch: string;
    }
  | {
      kind: 'squash-commits';
      target: CommitRangeTarget;
      message: string;
    }
  | { kind: 'cherry-pick-commits' | 'drop-commits'; target: CommitRangeTarget };
export type OperationResult =
  | {
      kind: 'success';
      backend: Backend | null;
      replacementSha?: string;
      branchRestore?: BranchRestoreHandle;
      message?: string;
    }
  | { kind: 'cancelled'; backend: Backend | null }
  | {
      kind: 'conflict' | 'error';
      backend: Backend | null;
      message: string;
      recovery?: 'source-control';
      branchRestore?: BranchRestoreHandle;
      updateDecision?: BranchUpdateDecision;
    };
export interface BranchUpdateContinuation {
  target: Extract<GitAction, { kind: 'update-branch' }>;
  checkout: { ref: string | null; sha: string };
  fetchedSha: string;
  incomingCount: number;
  remote: string;
  remoteRef: string;
}
export interface BranchUpdateDecision {
  kind: 'checkout' | 'integrate';
  continuation: BranchUpdateContinuation;
}
export interface BranchDeletionTarget {
  refId: string;
  expectedSha: string;
}
export interface BranchRestoreHandle {
  name: string;
  token: string;
  names?: readonly string[];
}
export interface Selection {
  sha: string;
  parentSha: string | null;
  filePath: string | null;
}
export interface ScrollAnchor {
  sha: string;
  offset: number;
}
export interface RestorableView {
  repositoryId: string | null;
  activeView: 'log' | 'worktrees';
  scope: Scope;
  text: string;
  selectedRefId: string | null;
  selection: Selection | null;
  anchor: ScrollAnchor | null;
  paneWidths: [number, number];
  branchesCollapsed?: boolean;
  historyColumnWidths?: [number, number] | null;
  filters?: HistoryFilters;
  showHash?: boolean;
  hashColumnWidth?: number;
  presentation?: HistoryPresentation;
}

export interface CommitRangeTarget {
  shas: readonly string[];
  expectedBranch: string;
  expectedHeadSha: string;
}
