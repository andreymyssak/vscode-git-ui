import type { RepositoryInfo } from './model';

export interface WorkingFile {
  path: string;
  originalPath: string;
  status: string;
  staged: boolean;
  working: boolean;
  untracked: boolean;
}

export interface Stash {
  sha: string;
  selector: string;
  message: string;
  date: string;
  base: string;
}

export interface StashFile {
  path: string;
  originalPath: string;
  status: string;
  snapshot: 'working' | 'index' | 'untracked';
  oldRef: string | null;
  newRef: string;
  deleted: boolean;
}

export type SourceControlTab = 'commit' | 'stash';
export type CommitMode = { kind: 'new' } | { kind: 'amend'; headSha: string };
export type Loaded<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: T[] };

export interface StashEntry extends Stash {
  viewId: string;
  files: Loaded<StashFile> | null;
}

export interface SourceControlOperation {
  kind:
    | 'merge'
    | 'rebase'
    | 'cherry-pick'
    | 'revert'
    | 'cherry-pick-files'
    | 'revert-files'
    | 'conflicts';
  token: string;
  paths: string[];
}

export interface SourceControlRepository {
  info: RepositoryInfo;
  pathLabel: { root: string; separator: '/' | '\\' };
  changes: Loaded<WorkingFile>;
  stashes: Loaded<StashEntry>;
  operation: Loaded<SourceControlOperation>;
  checked: string[];
  draft: string;
  draftEditId: string | null;
  commitMode: CommitMode;
}

export interface SourceControlState {
  hoverDelay: number;
  repositories: SourceControlRepository[];
  repositoryId: string | null;
  tab: SourceControlTab;
  busy: boolean;
  generating: boolean;
  reveal: { repositoryId: string; path: string; sequence: number } | null;
}

export interface StashFileKey {
  path: string;
  snapshot: StashFile['snapshot'];
}

type SelectedFileAction =
  | 'commit-selected'
  | 'stash-selected'
  | 'copy-paths'
  | 'rollback'
  | 'resolve-conflicts'
  | 'accept-current'
  | 'accept-incoming'
  | 'stage-files'
  | 'unstage-files'
  | 'delete-files';

export const sourceControlRepositoryActions = [
  'pull',
  'push',
  'fetch',
  'checkout-branch',
  'new-branch',
  'new-branch-checkout',
  'new-branch-from',
  'merge-current',
  'rebase-current',
  'rename-current-branch',
  'delete-local-branch',
  'delete-remote-branch',
  'publish-branch',
  'create-tag',
  'delete-tag',
  'delete-remote-tag',
  'push-tags',
] as const;

export type SourceControlRepositoryAction =
  (typeof sourceControlRepositoryActions)[number];

export function isSourceControlRepositoryAction(
  value: unknown,
): value is SourceControlRepositoryAction {
  return sourceControlRepositoryActions.some((kind) => kind === value);
}

export type SourceControlRequest =
  | {
      [Kind in SourceControlRepositoryAction]: {
        kind: Kind;
        repositoryId: string;
      };
    }[SourceControlRepositoryAction]
  | { kind: 'abort-operation'; repositoryId: string; token: string }
  | { kind: 'ready'; repositoryId: string | null; tab: SourceControlTab }
  | { kind: 'refresh' }
  | { kind: 'tab'; tab: SourceControlTab }
  | { kind: 'repository'; repositoryId: string }
  | { kind: 'check'; repositoryId: string; paths: string[]; checked: boolean }
  | { kind: 'message'; repositoryId: string; message: string; editId: string }
  | { kind: 'amend'; repositoryId: string; enabled: boolean }
  | {
      kind:
        'commit' | 'stash' | 'stash-silently' | 'generate' | 'reveal-working';
      repositoryId: string;
    }
  | { kind: 'cancel-generation' }
  | {
      [Kind in SelectedFileAction]: {
        kind: Kind;
        repositoryId: string;
        paths: string[];
      };
    }[SelectedFileAction]
  | {
      kind: 'reveal-in-os' | 'reveal-in-explorer';
      repositoryId: string;
      path: string;
      paths: string[];
    }
  | {
      kind: 'open-stash-files';
      repositoryId: string;
      sha: string;
      files: StashFileKey[];
    }
  | { kind: 'open-working'; repositoryId: string; path: string; index: boolean }
  | {
      kind: 'discard-working';
      repositoryId: string;
      path: string;
    }
  | {
      kind: 'restore-stash' | 'delete-stash' | 'rename-stash';
      repositoryId: string;
      sha: string;
    }
  | { kind: 'load-stash'; repositoryId: string; sha: string }
  | {
      kind: 'open-stash-file';
      repositoryId: string;
      sha: string;
      file: StashFileKey;
    }
  | {
      kind: 'restore-stash-files' | 'delete-stash-files';
      repositoryId: string;
      sha: string;
      files: StashFileKey[];
    };

export type SourceControlResponse = {
  kind: 'source-control-state';
  state: SourceControlState;
};

export interface SourceControlBridge {
  send(request: SourceControlRequest): void;
  subscribe(listener: (response: SourceControlResponse) => void): () => void;
  getState(): unknown;
  setState(value: unknown): void;
  dispose(): void;
}
