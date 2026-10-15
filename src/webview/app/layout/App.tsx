import { LogPage } from '@webview/pages/log';
import { WorktreesPage } from '@webview/pages/worktrees';
import type { BrowserBridge } from '@webview/shared/api';
import { FileIconThemeProvider } from '@webview/shared/ui';

import { useBrowserState } from '../model/useBrowserState';
import styles from './App.module.css';
import { PanelHeader } from './PanelHeader';
import { RenderMeasurement } from './RenderMeasurement';

export function App({ bridge }: { bridge: BrowserBridge }) {
  const controller = useBrowserState(bridge);
  const { state, onLogIntent, request } = controller;

  return (
    <FileIconThemeProvider bridge={bridge}>
      <div className={styles.app}>
        <RenderMeasurement snapshot={state} />
        <PanelHeader {...controller} />
        <div className={styles.page} hidden={state.activeView !== 'log'}>
          <LogPage data={state} onIntent={onLogIntent} />
        </div>
        <div className={styles.page} hidden={state.activeView !== 'worktrees'}>
          <WorktreesPage
            key={state.repository?.id ?? ''}
            repositoryId={state.repository?.id ?? ''}
            generation={state.generation}
            worktrees={state.worktrees}
            error={state.worktreesError}
            busy={
              state.worktreesLoading ||
              (state.operation?.section === 'worktrees' &&
                state.operation.phase === 'running')
            }
            onRequest={request}
          />
        </div>
      </div>
    </FileIconThemeProvider>
  );
}
