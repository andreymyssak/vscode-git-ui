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
  files: Loaded<StashFile> | null;
}

export interface SourceControlRepository {
  info: RepositoryInfo;
  pathLabel: { root: string; separator: '/' | '\\' };
  changes: Loaded<WorkingFile>;
  stashes: Loaded<StashEntry>;
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

export type SourceControlRequest =
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
      kind:
        | 'commit-selected'
        | 'stash-selected'
        | 'open-files'
        | 'copy-paths'
        | 'rollback';
      repositoryId: string;
      paths: string[];
    }
  | {
      kind: 'open-working-files';
      repositoryId: string;
      paths: string[];
      index: boolean;
    }
  | {
      kind: 'open-stash-files';
      repositoryId: string;
      sha: string;
      files: StashFileKey[];
    }
  | { kind: 'open-working'; repositoryId: string; path: string; index: boolean }
  | {
      kind: 'discard-working' | 'open-file';
      repositoryId: string;
      path: string;
    }
  | {
      kind: 'load-stash' | 'restore-stash' | 'delete-stash';
      repositoryId: string;
      sha: string;
    }
  | {
      kind: 'open-stash-file';
      repositoryId: string;
      sha: string;
      file: StashFileKey;
    }
  | {
      kind: 'restore-stash-files';
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
