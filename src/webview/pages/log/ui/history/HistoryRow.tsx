import clsx from 'clsx';
import { flushSync } from 'react-dom';

import type { CommitRecord, Reference } from '@contracts/model';
import {
  dispatchContextMenu,
  offsetPointerContextMenu,
} from '@webview/shared/ui';

import type { GraphRow } from '../../lib/graph/adapter';
import {
  canCherryPickLoadedRange,
  canEditLoadedCommit,
} from '../../model/commit-action-hints';
import type { CommitGesture } from '../../model/commit-selection';
import type { Columns } from '../../model/history-columns';
import { historyDestination } from '../../model/history-navigation';
import type { LogData, LogIntent } from '../../model/view';
import { GraphDrawing } from './GraphDrawing';
import styles from './HistoryPane.module.css';
import { ReferenceLabels } from './ReferenceLabels';

interface Props {
  data: LogData;
  commit: CommitRecord;
  graph: GraphRow;
  index: number;
  columns: Columns;
  viewportHeight: number;
  revisionWidth?: number;
  references?: readonly Reference[];
  canSquash?: boolean;
  canDrop?: boolean;
  canCherryPick?: boolean;
  onIntent(this: void, intent: LogIntent): void;
  onNavigate(
    this: void,
    sha: string,
    scrollTop: number,
    gesture: CommitGesture,
  ): void;
}

export function HistoryRow({
  data,
  commit,
  graph,
  index,
  columns,
  viewportHeight,
  revisionWidth = 100,
  references,
  canSquash = false,
  canDrop = false,
  canCherryPick,
  onIntent,
  onNavigate,
}: Props) {
  const timestamp = commit.commitDate ? new Date(commit.commitDate) : null;
  const selected = data.commitRange.selectedShas.includes(commit.sha);
  const user = data.annotations.user;
  const mine =
    data.presentation.highlightMyCommits &&
    !!user &&
    (user.email
      ? user.email === commit.authorEmail
      : user.name === commit.authorName);
  const merge =
    data.presentation.highlightMergeCommits && commit.parents.length > 1;
  const currentBranch =
    data.presentation.highlightCurrentBranch &&
    data.annotations.currentBranch.includes(commit.sha);
  const highlights = [
    graph.viewModel.kind === 'HEAD' && 'Current checkout',
    mine && 'Your commit',
    merge && 'Merge commit',
    currentBranch && 'Current branch',
  ]
    .filter(Boolean)
    .join('. ');
  const selection = selected ? data.commitRange.selectedShas : [commit.sha];
  const rowReferences =
    references ?? data.refs.filter((ref) => ref.sha === commit.sha);
  const context = {
    webviewSection: 'commit',
    logOperationBusy: false,
    repositoryId: data.repository?.id ?? '',
    generation: data.generation,
    commitSha: commit.sha,
    commitShas: selection,
    commitSelectionCount: selection.length,
    commitCanDrop: selected && canDrop,
    commitCanSquash: selected && selection.length > 1 && canSquash,
    commitCanEdit:
      selection.length === 1 && canEditLoadedCommit(data, commit.sha),
    commitCanCherryPick: selected
      ? (canCherryPick ?? canCherryPickLoadedRange(data, selection))
      : !!data.repository?.branch && commit.parents.length <= 1,
    preventDefaultContextMenuItems: true,
  };

  return (
    <div
      data-commit-row=""
      data-sha={commit.sha}
      data-vscode-context={JSON.stringify(context)}
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected}
      aria-description={highlights || undefined}
      tabIndex={
        data.selectedSha === commit.sha || (!data.selectedSha && index === 0)
          ? 0
          : -1
      }
      className={clsx(
        styles['commit-row'],
        mine && styles.mine,
        merge && styles.merge,
        currentBranch && styles['current-branch'],
      )}
      style={{
        top: index * 22,
        gridTemplateColumns: [
          ...columns.filter((width) => width > 0),
          ...(data.showHash ? [revisionWidth] : []),
        ]
          .map((width) => width + 'px')
          .join(' '),
      }}
      onClick={(event) =>
        onIntent({
          kind: 'select-commit',
          sha: commit.sha,
          ...(event.shiftKey ? { gesture: 'extend' } : {}),
        })
      }
      onContextMenu={(event) => {
        if (offsetPointerContextMenu(event.nativeEvent, event.currentTarget))
          return;
        flushSync(() =>
          onIntent({
            kind: 'select-commit',
            sha: commit.sha,
            scrollTop: data.scrollTop,
            gesture: 'context',
          }),
        );
        event.currentTarget.focus({ preventScroll: true });
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (
          event.key === 'ContextMenu' ||
          (event.shiftKey && event.key === 'F10')
        ) {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();

          dispatchContextMenu(
            event.currentTarget,
            bounds.left + 20,
            bounds.top + 11,
          );

          return;
        }

        if (event.key === 'Enter') {
          event.preventDefault();
          onIntent({ kind: 'select-commit', sha: commit.sha });

          return;
        }

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const next = historyDestination(
            data.commits,
            index,
            event.key,
            viewportHeight,
          );

          if (next) {
            onNavigate(
              next.sha,
              next.scrollTop,
              event.shiftKey ? 'extend' : 'plain',
            );
          }
        }
      }}
    >
      <span role="cell" data-history-cell="" className={styles['history-cell']}>
        <GraphDrawing row={graph} />
        <span data-subject="" className={styles.subject}>
          <span data-subject-message="" className={styles['subject-message']}>
            {commit.message.split('\n')[0]}
            {graph.missingParents.length > 0 && (
              <span
                className={styles.continuation}
                title={`${graph.missingParents.length} parent(s) outside the loaded results`}
              >
                …
              </span>
            )}
          </span>
        </span>
        <ReferenceLabels
          refs={rowReferences}
          repository={data.repository}
          sha={commit.sha}
        />
      </span>
      {data.presentation.showAuthor && (
        <span
          role="cell"
          data-author=""
          className={styles.author}
          title={commit.authorName ?? 'Unknown author'}
        >
          {commit.authorName ?? 'Unknown author'}
        </span>
      )}
      {data.presentation.showDate && (
        <span
          role="cell"
          data-date=""
          className={styles.date}
          title={timestamp?.toLocaleString() ?? 'Unknown date'}
        >
          {timestamp
            ? timestamp.toLocaleString(undefined, {
                dateStyle: 'short',
                timeStyle: 'short',
              })
            : 'Unknown date'}
        </span>
      )}
      {data.showHash && (
        <span
          role="cell"
          data-revision=""
          className={styles.revision}
          title={commit.sha}
        >
          {commit.sha.slice(0, 8)}
        </span>
      )}
    </div>
  );
}
