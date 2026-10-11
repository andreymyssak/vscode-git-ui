import type { SourceControlTab } from '@contracts/source-control';
import { isRecord } from '@contracts/validation';

export const messageHeightLimits = { min: 140, max: 600, initial: 180 };

export interface SourceControlView {
  repositoryId: string | null;
  tab: SourceControlTab;
  collapsed: string[];
  expandedStashes: string[];
  groupByDirectory: boolean;
  messageHeight: number;
}

export function readView(value: unknown): SourceControlView {
  if (!isRecord(value))
    return {
      repositoryId: null,
      tab: 'commit',
      collapsed: [],
      expandedStashes: [],
      groupByDirectory: true,
      messageHeight: messageHeightLimits.initial,
    };

  return {
    repositoryId:
      typeof value.repositoryId === 'string' ? value.repositoryId : null,
    tab: value.tab === 'stash' ? 'stash' : 'commit',
    collapsed: Array.isArray(value.collapsed)
      ? value.collapsed.filter(
          (item: unknown): item is string => typeof item === 'string',
        )
      : [],
    expandedStashes: Array.isArray(value.expandedStashes)
      ? value.expandedStashes.filter(
          (item: unknown): item is string => typeof item === 'string',
        )
      : [],
    groupByDirectory: value.groupByDirectory !== false,
    messageHeight:
      typeof value.messageHeight === 'number' &&
      Number.isFinite(value.messageHeight)
        ? Math.max(
            messageHeightLimits.min,
            Math.min(messageHeightLimits.max, value.messageHeight),
          )
        : messageHeightLimits.initial,
  };
}

export function folderKey(repositoryId: string, section: string, path: string) {
  return JSON.stringify([repositoryId, section, path]);
}
