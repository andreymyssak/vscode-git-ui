import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { LogData } from './view';

/** The app supplies read access; the page sends changes through LogIntent. */
export interface LogStateSource {
  getState(this: void): LogData;
  getInitialState(this: void): LogData;
  subscribe(
    this: void,
    listener: (state: LogData, previous: LogData) => void,
  ): () => void;
}

export function useLogSelector<Snapshot>(
  source: LogStateSource,
  selector: (data: LogData) => Snapshot,
): Snapshot {
  return useStore(source, useShallow(selector));
}

export function selectLogLayout(data: LogData) {
  return {
    paneWidths: data.paneWidths,
    branchesCollapsed: data.branchesCollapsed,
  };
}

export function selectBranches(data: LogData) {
  return {
    repository: data.repository,
    refs: data.refs,
    referencesReady: data.referencesReady ?? true,
    selectedRefId: data.selectedRefId,
    scope: data.scope,
    generation: data.generation,
    loading: data.loading,
    branchesCollapsed: data.branchesCollapsed,
    operation: data.operation,
  };
}

export function selectHistory(data: LogData) {
  return {
    repository: data.repository,
    refs: data.refs,
    commits: data.commits,
    scope: data.scope,
    selectedSha: data.selectedSha,
    commitRange: data.commitRange,
    details: data.details,
    generation: data.generation,
    nextCursor: data.nextCursor,
    loading: data.loading,
    retainHistory: data.retainHistory ?? false,
    text: data.text,
    filters: data.filters,
    showHash: data.showHash,
    presentation: data.presentation,
    annotations: data.annotations,
    hashColumnWidth: data.hashColumnWidth,
    scrollTop: data.scrollTop,
    paneWidths: data.paneWidths,
    historyColumnWidths: data.historyColumnWidths,
  };
}

export function selectDetails(data: LogData) {
  return {
    repository: data.repository,
    refs: data.refs,
    selectedSha: data.selectedSha,
    selectedParentSha: data.selectedParentSha,
    selectedFilePath: data.selectedFilePath,
    details: data.details,
    files: data.files,
    fileErrors: data.fileErrors,
    generation: data.generation,
    loading: data.loading,
    error: data.error ?? null,
  };
}

export function selectToolbar(data: LogData) {
  return {
    text: data.text,
    filters: data.filters,
    showHash: data.showHash,
    presentation: data.presentation,
  };
}

export function selectHistoryBusy(data: LogData) {
  return (
    data.loading ||
    (data.operation?.section === 'history' &&
      data.operation.phase === 'running')
  );
}

export type BranchData = Pick<LogData, keyof ReturnType<typeof selectBranches>>;
export type HistoryData = Pick<LogData, keyof ReturnType<typeof selectHistory>>;
export type DetailsData = Pick<LogData, keyof ReturnType<typeof selectDetails>>;
export type ToolbarData = Pick<LogData, keyof ReturnType<typeof selectToolbar>>;
