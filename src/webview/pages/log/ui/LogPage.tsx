import { useLayoutEffect, useRef, useState } from 'react';

import { ProgressBar, SplitHandle } from '@webview/shared/ui';

import { fitPaneWidths } from '../model/pane-widths';
import type { LogData, LogIntent } from '../model/view';
import { BranchesPane } from './branches/BranchesPane';
import { CommitDetails } from './details/CommitDetails';
import { HistoryPane } from './history/HistoryPane';
import styles from './LogPage.module.css';
import { HistoryToolbar } from './search/HistoryToolbar';

export interface LogPageProps {
  data: LogData;
  onIntent(this: void, intent: LogIntent): void;
}
export function LogPage({ data, onIntent }: LogPageProps) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(620);

  useLayoutEffect(() => {
    const node = root.current;

    if (!node) return;
    const measure = () => {
      if (node.clientWidth) setWidth(node.clientWidth);
    };

    measure();
    const observer = new ResizeObserver(measure);

    observer.observe(node);

    return () => observer.disconnect();
  }, []);
  const busy =
    data.loading ||
    (data.operation?.section === 'history' &&
      data.operation.phase === 'running');
  const widths = fitPaneWidths(width, data.paneWidths, data.branchesCollapsed);
  const change = (side: 0 | 1, value: number) => {
    const next: [number, number] = [...widths];

    if (data.branchesCollapsed) next[0] = data.paneWidths[0];
    next[side] = value;
    onIntent({ kind: 'pane-widths', widths: next });
  };

  return (
    <div
      ref={root}
      id="log-view"
      className={styles.layout}
      style={{
        gridTemplateColumns: `${widths[0]}px ${data.branchesCollapsed ? 0 : 5}px minmax(240px,1fr) 5px ${widths[1]}px`,
      }}
    >
      <BranchesPane data={data} onIntent={onIntent} />
      {data.branchesCollapsed ? (
        <div aria-hidden="true" />
      ) : (
        <SplitHandle
          id="left-resizer"
          label="Resize branches"
          value={widths[0]}
          min={150}
          max={600}
          direction={1}
          onChange={(value) => change(0, value)}
        />
      )}
      <section id="history-pane" className={styles.history} aria-busy={busy}>
        <ProgressBar active={busy} />
        <HistoryToolbar data={data} onIntent={onIntent} />
        <HistoryPane data={data} onIntent={onIntent} />
      </section>
      <SplitHandle
        id="right-resizer"
        label="Resize details"
        value={widths[1]}
        min={150}
        max={600}
        direction={-1}
        onChange={(value) => change(1, value)}
      />
      <CommitDetails data={data} onIntent={onIntent} />
    </div>
  );
}
