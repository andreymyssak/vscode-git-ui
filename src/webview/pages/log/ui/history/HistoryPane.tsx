import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import type { Reference } from '@contracts/model';

import { GraphAdapter } from '../../lib/graph/adapter';
import { graphWidth } from '../../lib/graph/rows';
import {
  canCherryPickLoadedRange,
  canDropLoadedRange,
  canSquashLoadedRange,
} from '../../model/commit-action-hints';
import type { CommitGesture } from '../../model/commit-selection';
import { fitColumns } from '../../model/history-columns';
import { historyDestination } from '../../model/history-navigation';
import { useHistoryWindow } from '../../model/history-window';
import { useHistoryPaging } from '../../model/useHistoryPaging';
import type { LogData, LogIntent } from '../../model/view';
import { HistoryColumns } from './HistoryColumns';
import styles from './HistoryPane.module.css';
import { HistoryRow } from './HistoryRow';

export function HistoryPane({
  data,
  onIntent,
}: {
  data: LogData;
  onIntent(this: void, intent: LogIntent): void;
}) {
  const [settled, setSettled] = useState(data);
  const retained =
    data.loading &&
    !data.commits.length &&
    settled.commits.length > 0 &&
    settled.repository?.id === data.repository?.id;

  if (!retained && settled !== data) setSettled(data);
  const displayed = retained
    ? {
        ...settled,
        loading: true,
        nextCursor: null,
        showHash: data.showHash,
        presentation: data.presentation,
        hashColumnWidth: data.hashColumnWidth,
        historyColumnWidths: data.historyColumnWidths,
        paneWidths: data.paneWidths,
      }
    : data;

  return (
    <HistoryContent
      data={displayed}
      inactive={retained}
      onIntent={retained ? ignoreIntent : onIntent}
    />
  );
}

function ignoreIntent() {}

function HistoryContent({
  data,
  onIntent,
  inactive,
}: {
  data: LogData;
  onIntent(this: void, intent: LogIntent): void;
  inactive: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{
    sha: string;
    generation: number;
    repositoryId: string | undefined;
  } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0, top: 28 });
  const [scrollLeft, setScrollLeft] = useState(0);
  const mode =
    data.text ||
    data.filters.author.kind !== 'all' ||
    data.filters.date !== 'all'
      ? 'search'
      : 'history';
  const rows = useMemo(
    () =>
      new GraphAdapter().layout(data.commits, mode, data.repository?.headSha),
    [data.commits, mode, data.repository?.headSha],
  );
  const width = useMemo(() => graphWidth(rows), [rows]);
  const refs = useMemo(() => {
    const map = new Map<string, Reference[]>();

    for (const ref of data.refs) {
      const list = map.get(ref.sha) ?? [];

      list.push(ref);
      map.set(ref.sha, list);
    }

    return map;
  }, [data.refs]);
  const hasReferences =
    data.refs.length > 0 ||
    data.commits.some((commit) => commit.sha === data.repository?.headSha);
  const minimum = width + 106 + (hasReferences ? 40 : 0);
  const revisionWidth = data.showHash
    ? Math.min(
        data.hashColumnWidth,
        Math.max(
          65,
          viewport.width -
            minimum -
            (data.presentation.showAuthor ? 65 : 0) -
            (data.presentation.showDate ? 80 : 0),
        ),
      )
    : 0;
  const columns = fitColumns(
    viewport.width - revisionWidth,
    minimum,
    data.historyColumnWidths,
    { author: data.presentation.showAuthor, date: data.presentation.showDate },
  );
  const [, defaultAuthor, defaultDate] = fitColumns(
    viewport.width - revisionWidth,
    minimum,
    null,
    { author: data.presentation.showAuthor, date: data.presentation.showDate },
  );
  const [, preferredAuthor, preferredDate] = fitColumns(
    viewport.width - revisionWidth,
    minimum,
    null,
  );

  const window = useHistoryWindow(root, data.commits, data.scrollTop);
  const canSquash = useMemo(
    () =>
      canSquashLoadedRange({
        repository: data.repository,
        commits: data.commits,
        refs: data.refs,
        commitRange: data.commitRange,
      }),
    [data.repository, data.commits, data.refs, data.commitRange],
  );
  const canDrop = useMemo(
    () =>
      canDropLoadedRange({
        repository: data.repository,
        commits: data.commits,
        refs: data.refs,
        commitRange: data.commitRange,
      }),
    [data.repository, data.commits, data.refs, data.commitRange],
  );
  const canCherryPick = useMemo(
    () =>
      canCherryPickLoadedRange({
        repository: data.repository,
        commits: data.commits,
        commitRange: data.commitRange,
        details: data.details,
      }),
    [data.repository, data.commits, data.commitRange, data.details],
  );
  const navigate = (sha: string, scrollTop: number, gesture: CommitGesture) => {
    pendingFocus.current = {
      sha,
      generation: data.generation,
      repositoryId: data.repository?.id,
    };
    // A wheel scroll can change the DOM before its event updates model state.
    // Restore the keyboard destination even when the stored offset is unchanged.
    if (root.current && root.current.scrollTop !== scrollTop)
      root.current.scrollTop = scrollTop;
    flushSync(() =>
      onIntent({ kind: 'select-commit', sha, scrollTop, gesture }),
    );
  };

  useHistoryPaging(data, viewport.height, onIntent);
  useLayoutEffect(() => {
    const node = root.current;

    if (!node) return;
    const measure = () => {
      if (node.clientWidth && node.clientHeight) {
        const next = {
          width: node.clientWidth,
          height: node.clientHeight,
          top: node.offsetTop,
        };

        setViewport((old) =>
          old.width === next.width &&
          old.height === next.height &&
          old.top === next.top
            ? old
            : next,
        );
      }
    };

    measure();
    const observer = new ResizeObserver(measure);

    observer.observe(node);

    return () => observer.disconnect();
  }, [data.paneWidths]);
  useLayoutEffect(() => {
    const node = root.current;

    if (node && node.scrollTop !== data.scrollTop)
      node.scrollTop = data.scrollTop;
  }, [data.scrollTop, data.commits.length, inactive]);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    const node = root.current;

    if (!pending || !node) return;
    if (
      pending.sha !== data.selectedSha ||
      pending.generation !== data.generation ||
      pending.repositoryId !== data.repository?.id ||
      (document.activeElement !== document.body &&
        !node.contains(document.activeElement))
    ) {
      pendingFocus.current = null;

      return;
    }

    const target = [
      ...node.querySelectorAll<HTMLElement>('[data-commit-row]'),
    ].find((row) => row.dataset.sha === pending.sha);

    if (target) {
      pendingFocus.current = null;
      target.focus({ preventScroll: true });
    }
  }, [window.items, data.selectedSha, data.generation, data.repository?.id]);

  return (
    <>
      <div
        ref={root}
        id="history"
        className={styles.viewport}
        role="grid"
        aria-label="Commit history"
        aria-rowcount={
          data.loading || data.nextCursor ? -1 : data.commits.length
        }
        aria-multiselectable={true}
        inert={inactive}
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')
          )
            return;
          event.preventDefault();
          const next = historyDestination(
            data.commits,
            data.commits.findIndex((commit) => commit.sha === data.selectedSha),
            event.key,
            viewport.height,
          );

          if (next)
            navigate(
              next.sha,
              next.scrollTop,
              event.shiftKey ? 'extend' : 'plain',
            );
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            pendingFocus.current = null;
        }}
        onScroll={(event) => {
          const node = event.currentTarget;

          setScrollLeft(node.scrollLeft);
          if (node.scrollTop !== data.scrollTop) {
            const commit = data.commits[Math.floor(node.scrollTop / 22)];

            onIntent({
              kind: 'scroll',
              scrollTop: node.scrollTop,
              anchor: commit
                ? { sha: commit.sha, offset: node.scrollTop % 22 }
                : null,
            });
          }
        }}
      >
        <div
          data-history-content=""
          className={styles['history-content']}
          style={{
            height: window.totalSize,
            minWidth: columns.reduce(
              (sum, width) => sum + width,
              revisionWidth,
            ),
          }}
        >
          {window.items.map((item) => {
            const index = item.index;
            const commit = data.commits[index]!;
            const graph = rows[index];

            return graph ? (
              <HistoryRow
                key={commit.sha}
                data={data}
                commit={commit}
                graph={graph}
                index={index}
                graphWidth={width}
                columns={columns}
                viewportHeight={viewport.height}
                revisionWidth={revisionWidth}
                references={refs.get(commit.sha) ?? []}
                canSquash={canSquash}
                canDrop={canDrop}
                canCherryPick={canCherryPick}
                onIntent={onIntent}
                onNavigate={navigate}
              />
            ) : null;
          })}
        </div>
      </div>
      <HistoryColumns
        columns={columns}
        defaults={[defaultAuthor, defaultDate]}
        preferred={data.historyColumnWidths ?? [preferredAuthor, preferredDate]}
        minimum={minimum}
        width={viewport.width}
        height={viewport.height}
        top={viewport.top}
        scrollLeft={scrollLeft}
        revisionWidth={revisionWidth}
        onRevisionChange={(width, metadata) =>
          onIntent({
            kind: 'hash-column',
            width,
            ...(metadata ? { metadata } : {}),
          })
        }
        onChange={(widths) => onIntent({ kind: 'history-columns', widths })}
      />
    </>
  );
}
