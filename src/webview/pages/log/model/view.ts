import type { ActiveLogOperation, RequestBody } from '@contracts/messages';
import type {
  CommitRecord,
  FileChange,
  HistoryAnnotations,
  HistoryFilters,
  HistoryPresentation,
  Reference,
  RepositoryInfo,
  Scope,
  ScrollAnchor,
} from '@contracts/model';

import type { CommitGesture, CommitRange } from './commit-selection';

export interface LogData {
  repository: RepositoryInfo | null;
  refs: readonly Reference[];
  referencesReady?: boolean;
  commits: readonly CommitRecord[];
  scope: Scope;
  selectedRefId: string | null;
  selectedSha: string | null;
  commitRange: CommitRange;
  selectedParentSha: string | null;
  selectedFilePath: string | null;
  anchor: ScrollAnchor | null;
  details: CommitRecord | null;
  files: Readonly<Record<string, FileChange[]>>;
  fileErrors: Readonly<Record<string, string | undefined>>;
  generation: number;
  nextCursor: string | null;
  loading: boolean;
  retainHistory?: boolean;
  operation: ActiveLogOperation | null;
  error?: string | null;
  text: string;
  filters: HistoryFilters;
  showHash: boolean;
  presentation: HistoryPresentation;
  annotations: HistoryAnnotations;
  hashColumnWidth: number;
  scrollTop: number;
  paneWidths: [number, number];
  branchesCollapsed: boolean;
  historyColumnWidths: [number, number] | null;
}
export type LogIntent =
  | { kind: 'select-ref'; refId: string | null }
  | { kind: 'apply-scope'; scope: Scope }
  | {
      kind: 'select-commit';
      sha: string;
      scrollTop?: number;
      menu?: boolean;
      gesture?: CommitGesture;
    }
  | { kind: 'search'; text: string }
  | { kind: 'filters'; filters: HistoryFilters }
  | { kind: 'show-hash'; show: boolean }
  | { kind: 'presentation'; presentation: HistoryPresentation }
  | { kind: 'hash-column'; width: number; metadata?: [number, number] }
  | { kind: 'scroll'; scrollTop: number; anchor: ScrollAnchor | null }
  | { kind: 'pane-widths'; widths: [number, number] }
  | { kind: 'branches-collapsed'; collapsed: boolean }
  | { kind: 'history-columns'; widths: [number, number] | null }
  | { kind: 'request'; body: RequestBody };
