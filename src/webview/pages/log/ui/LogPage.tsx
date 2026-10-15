import type { ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

import { ProgressBar, SplitHandle } from '@webview/shared/ui';

import { fitPaneWidths } from '../model/pane-widths';
import type { LogStateSource } from '../model/selectors';
import {
  selectBranches,
  selectDetails,
  selectHistory,
  selectHistoryBusy,
  selectLogLayout,
  selectToolbar,
  useLogSelector,
} from '../model/selectors';
import type { LogData, LogIntent } from '../model/view';
import { BranchesPane } from './branches/BranchesPane';
import { CommitDetails } from './details/CommitDetails';
import { HistoryPane } from './history/HistoryPane';
import styles from './LogPage.module.css';
import { HistoryToolbar } from './search/HistoryToolbar';

type IntentProps = { onIntent(this: void, intent: LogIntent): void };

type ConnectedProps = IntentProps & { source: LogStateSource };

export type LogPageProps = IntentProps &
  ({ source: LogStateSource } | { data: LogData });

export function LogPage(props: LogPageProps) {
  if ('source' in props) return <ConnectedLogPage {...props} />;
  const { data, onIntent } = props;

  return (
    <LogLayout
      data={data}
      onIntent={onIntent}
      branches={<BranchesPane data={data} onIntent={onIntent} />}
      details={<CommitDetails data={data} onIntent={onIntent} />}
      history={
        <HistorySection
          busy={selectHistoryBusy(data)}
          toolbar={<HistoryToolbar data={data} onIntent={onIntent} />}
          history={<HistoryPane data={data} onIntent={onIntent} />}
        />
      }
    />
  );
}

function ConnectedLogPage({ source, onIntent }: ConnectedProps) {
  const data = useLogSelector(source, selectLogLayout);

  return (
    <LogLayout
      data={data}
      onIntent={onIntent}
      branches={<ConnectedBranches source={source} onIntent={onIntent} />}
      details={<ConnectedDetails source={source} onIntent={onIntent} />}
      history={<ConnectedHistorySection source={source} onIntent={onIntent} />}
    />
  );
}

function ConnectedBranches({ source, onIntent }: ConnectedProps) {
  const data = useLogSelector(source, selectBranches);

  return <BranchesPane data={data} onIntent={onIntent} />;
}

function ConnectedDetails({ source, onIntent }: ConnectedProps) {
  const data = useLogSelector(source, selectDetails);

  return <CommitDetails data={data} onIntent={onIntent} />;
}

function ConnectedToolbar({ source, onIntent }: ConnectedProps) {
  const data = useLogSelector(source, selectToolbar);

  return <HistoryToolbar data={data} onIntent={onIntent} />;
}

function ConnectedHistory({ source, onIntent }: ConnectedProps) {
  const data = useLogSelector(source, selectHistory);

  return <HistoryPane data={data} onIntent={onIntent} />;
}

function ConnectedHistorySection({ source, onIntent }: ConnectedProps) {
  const busy = useLogSelector(source, selectHistoryBusy);

  return (
    <HistorySection
      busy={busy}
      toolbar={<ConnectedToolbar source={source} onIntent={onIntent} />}
      history={<ConnectedHistory source={source} onIntent={onIntent} />}
    />
  );
}

function HistorySection({
  busy,
  toolbar,
  history,
}: {
  busy: boolean;
  toolbar: ReactNode;
  history: ReactNode;
}) {
  return (
    <section id="history-pane" className={styles.history} aria-busy={busy}>
      <ProgressBar active={busy} />
      {toolbar}
      {history}
    </section>
  );
}

function LogLayout({
  data,
  onIntent,
  branches,
  details,
  history,
}: IntentProps & {
  data: Pick<LogData, 'paneWidths' | 'branchesCollapsed'>;
  branches: ReactNode;
  details: ReactNode;
  history: ReactNode;
}) {
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
      {branches}
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
      {history}
      <SplitHandle
        id="right-resizer"
        label="Resize details"
        value={widths[1]}
        min={150}
        max={600}
        direction={-1}
        onChange={(value) => change(1, value)}
      />
      {details}
    </div>
  );
}
