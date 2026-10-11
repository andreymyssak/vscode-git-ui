import { normalizeHistoryFilters } from '@contracts/history-filters';
import { readHistoryPresentation } from '@contracts/history-presentation';
import type { PanelBody, Result, SetupState } from '@contracts/messages';
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
  WorktreeInfo,
} from '@contracts/model';
import type { CommitGesture, CommitRange } from '@webview/pages/log/model';
import { selectCommitRange, singleCommitRange } from '@webview/pages/log/model';

export interface ViewState {
  repository: RepositoryInfo | null;
  repositories: RepositoryInfo[];
  refs: Reference[];
  worktrees: WorktreeInfo[];
  commits: CommitRecord[];
  scope: Scope;
  selectedRefId: string | null;
  selectedSha: string | null;
  commitRange: CommitRange;
  selectedParentSha: string | null;
  selectedFilePath: string | null;
  anchor: ScrollAnchor | null;
  details: CommitRecord | null;
  files: Record<string, FileChange[]>;
  fileErrors: Record<string, string | undefined>;
  generation: number;
  nextCursor: string | null;
  loading: boolean;
  restoring: boolean;
  error: string | null;
  setup: SetupState;
  text: string;
  filters: HistoryFilters;
  showHash: boolean;
  presentation: HistoryPresentation;
  annotations: HistoryAnnotations;
  hashColumnWidth: number;
  activeView: 'log' | 'worktrees';
  scrollTop: number;
  paneWidths: [number, number];
  branchesCollapsed: boolean;
  historyColumnWidths: [number, number] | null;
}
export type ViewEvent =
  | { kind: 'update'; patch: Partial<ViewState> }
  | { kind: 'host'; message: Result<PanelBody> }
  | {
      kind: 'restore-error';
      repositoryId: string;
      generation: number;
      message: string;
    }
  | { kind: 'select-ref'; refId: string | null }
  | { kind: 'apply-scope'; scope: Scope }
  | { kind: 'select-commit'; sha: string; gesture?: CommitGesture }
  | { kind: 'view'; view: 'log' | 'worktrees' };
export function initialView(): ViewState {
  return {
    repository: null,
    repositories: [],
    refs: [],
    worktrees: [],
    commits: [],
    scope: { kind: 'head' },
    selectedRefId: null,
    selectedSha: null,
    commitRange: singleCommitRange(null),
    selectedParentSha: null,
    selectedFilePath: null,
    anchor: null,
    details: null,
    files: {},
    fileErrors: {},
    generation: 0,
    nextCursor: null,
    loading: false,
    restoring: false,
    error: null,
    setup: 'ready',
    text: '',
    filters: normalizeHistoryFilters(),
    showHash: false,
    presentation: readHistoryPresentation(),
    annotations: { user: null, currentBranch: [] },
    hashColumnWidth: 100,
    activeView: 'log',
    scrollTop: 0,
    paneWidths: [220, 350],
    branchesCollapsed: false,
    historyColumnWidths: null,
  };
}

export function reduceView(state: ViewState, event: ViewEvent): ViewState {
  switch (event.kind) {
    case 'update':
      return { ...state, ...event.patch };
    case 'select-ref':
      return { ...state, selectedRefId: event.refId };
    case 'apply-scope':
      return {
        ...state,
        scope: event.scope,
        generation: state.generation + 1,
        loading: true,
        restoring: false,
        error: null,
        commits: [],
        selectedSha: null,
        commitRange: singleCommitRange(null),
        selectedParentSha: null,
        selectedFilePath: null,
        details: null,
        files: {},
        fileErrors: {},
        nextCursor: null,
        scrollTop: 0,
      };
    case 'select-commit': {
      const commitRange = selectCommitRange(
        state.commitRange,
        state.commits.map((commit) => commit.sha),
        event.sha,
        event.gesture ?? 'plain',
      );

      if (commitRange === state.commitRange) return state;

      return {
        ...state,
        selectedSha: event.sha,
        commitRange,
        ...(state.selectedSha === event.sha
          ? {}
          : {
              details: null,
              files: {},
              fileErrors: {},
              selectedParentSha: null,
              selectedFilePath: null,
            }),
        error: null,
      };
    }

    case 'view':
      return { ...state, activeView: event.view };
    case 'restore-error':
      return event.repositoryId === state.repository?.id &&
        event.generation >= state.generation
        ? {
            ...state,
            generation: event.generation,
            error: event.message,
            loading: false,
            restoring: false,
          }
        : state;
    case 'host': {
      const { body, generation } = event.message;

      if (body.kind === 'setup') {
        if (body.state !== 'ready' || event.message.repositoryId === '')
          return {
            ...initialView(),
            activeView: state.activeView,
            setup: body.state,
            repositories: body.repositories,
            generation,
            error: body.message || null,
            historyColumnWidths: state.historyColumnWidths,
            branchesCollapsed: state.branchesCollapsed,
            showHash: state.showHash,
            presentation: state.presentation,
            hashColumnWidth: state.hashColumnWidth,
          };

        return { ...state, setup: body.state, repositories: body.repositories };
      }

      if (generation < state.generation) return state;
      if (
        state.repository &&
        body.kind !== 'loading' &&
        body.kind !== 'history' &&
        event.message.repositoryId !== state.repository.id
      )
        return state;
      switch (body.kind) {
        case 'loading': {
          const preserveSelection =
            body.preserve && body.repository.id === state.repository?.id;

          return {
            ...(body.repository.id === state.repository?.id
              ? state
              : {
                  ...initialView(),
                  activeView: state.activeView,
                  paneWidths: state.paneWidths,
                  branchesCollapsed: state.branchesCollapsed,
                  historyColumnWidths: state.historyColumnWidths,
                  showHash: state.showHash,
                  presentation: state.presentation,
                  hashColumnWidth: state.hashColumnWidth,
                }),
            repositories: state.repositories,
            repository: body.repository,
            scope: body.scope,
            text: body.text,
            filters: normalizeHistoryFilters(body.filters),
            generation,
            loading: true,
            restoring: body.preserve === true,
            error: null,
            commits: [],
            selectedSha: preserveSelection ? state.selectedSha : null,
            commitRange: singleCommitRange(null),
            selectedParentSha: preserveSelection
              ? state.selectedParentSha
              : null,
            selectedFilePath: preserveSelection ? state.selectedFilePath : null,
            anchor: preserveSelection ? state.anchor : null,
            details: null,
            files: {},
            fileErrors: {},
            scrollTop: preserveSelection ? state.scrollTop : 0,
          };
        }

        case 'history': {
          const append =
            body.append &&
            body.repository.id === state.repository?.id &&
            generation === state.generation;
          const existing = append ? state.commits : [];
          const seen = new Set(existing.map((commit) => commit.sha));
          const commits = [
            ...existing,
            ...body.page.commits.filter((commit) => !seen.has(commit.sha)),
          ];
          const selectedSha =
            body.repository.id === state.repository?.id &&
            commits.some((commit) => commit.sha === state.selectedSha)
              ? state.selectedSha
              : null;
          const commitRange =
            append && selectedSha
              ? state.commitRange
              : singleCommitRange(selectedSha);

          return {
            ...state,
            setup: 'ready',
            repository: body.repository,
            refs: body.page.refs,
            selectedRefId:
              state.selectedRefId &&
              body.page.refs.some((ref) => ref.id === state.selectedRefId)
                ? state.selectedRefId
                : !state.refs.length
                  ? (body.page.refs.find(
                      (ref) =>
                        ref.kind === 'local' &&
                        ref.name === body.repository.branch,
                    )?.id ?? null)
                  : null,
            commits,
            annotations: {
              user: body.page.annotations?.user ?? null,
              currentBranch: [
                ...(append ? state.annotations.currentBranch : []),
                ...(body.page.annotations?.currentBranch ?? []),
              ],
            },
            selectedSha,
            commitRange,
            ...(selectedSha
              ? {}
              : {
                  details: null,
                  files: {},
                  fileErrors: {},
                  selectedParentSha: null,
                  selectedFilePath: null,
                }),
            nextCursor: body.page.nextCursor,
            scope: body.scope,
            text: body.text,
            filters: normalizeHistoryFilters(body.filters),
            generation,
            loading: body.restoring === true,
            restoring: body.restoring === true,
            error: null,
          };
        }

        case 'history-settled':
          return generation === state.generation && state.restoring
            ? { ...state, loading: false, restoring: false }
            : state;
        case 'notice':
          return state;
        case 'references':
          return generation === state.generation
            ? { ...state, refs: body.references }
            : state;
        case 'selection': {
          const selectedSha = state.commits.some(
            (commit) => commit.sha === body.sha,
          )
            ? body.sha
            : null;
          const index = body.anchor
            ? state.commits.findIndex(
                (commit) => commit.sha === body.anchor?.sha,
              )
            : -1;
          const changed = state.selectedSha !== selectedSha;

          return {
            ...state,
            selectedSha,
            commitRange: singleCommitRange(selectedSha),
            selectedParentSha: selectedSha ? body.parentSha : null,
            selectedFilePath: selectedSha ? body.filePath : null,
            anchor: body.anchor,
            scrollTop: index >= 0 ? index * 22 + (body.anchor?.offset ?? 0) : 0,
            ...(changed ? { details: null, files: {}, fileErrors: {} } : {}),
          };
        }

        case 'worktrees':
          return { ...state, worktrees: body.worktrees };
        case 'reveal':
          if (!state.commits.some((commit) => commit.sha === body.sha))
            return state;

          return {
            ...state,
            selectedSha: body.sha,
            commitRange: singleCommitRange(body.sha),
            files: {},
            fileErrors: {},
            details: null,
          };
        case 'details':
          return body.commit.sha === state.selectedSha
            ? { ...state, details: body.commit }
            : state;
        case 'files':
        case 'files-error':
          return body.sha === state.selectedSha &&
            (body.parentSha === null
              ? state.details?.parents.length === 0
              : state.details?.parents.includes(body.parentSha))
            ? {
                ...state,
                ...(body.kind === 'files'
                  ? {
                      files: {
                        ...state.files,
                        [body.parentSha ?? 'root']: body.files,
                      },
                    }
                  : {}),
                fileErrors: {
                  ...state.fileErrors,
                  [body.parentSha ?? 'root']:
                    body.kind === 'files-error' ? body.message : undefined,
                },
              }
            : state;
        case 'error':
          return { ...state, error: body.message, loading: state.restoring };
        case 'operation':
          return state;
        case 'file-icon-theme':
        case 'filters':
          return state;
        default: {
          const exhaustive: never = body;

          return exhaustive;
        }
      }
    }
  }
}
