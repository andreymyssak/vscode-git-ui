import { LogPage } from '@webview/pages/log';
import { WorktreesPage } from '@webview/pages/worktrees';
import type { BrowserBridge } from '@webview/shared/api';
import { FileIconThemeProvider } from '@webview/shared/ui';

import type { BrowserSession } from '../model/browser-session';
import { useBrowserSelector, useBrowserState } from '../model/useBrowserState';
import styles from './App.module.css';
import { PanelHeader } from './PanelHeader';
import { RenderMeasurement } from './RenderMeasurement';

export function App({ bridge }: { bridge: BrowserBridge }) {
  const controller = useBrowserState(bridge, (state) => state.activeView);
  const { state: activeView, onLogIntent, store } = controller;

  return (
    <FileIconThemeProvider bridge={bridge}>
      <div className={styles.app}>
        <RenderMeasurement store={store} />
        <PanelHeader {...controller} />
        <div
          id="log-panel"
          role="tabpanel"
          aria-labelledby="log-tab"
          className={styles.page}
          hidden={activeView !== 'log'}
        >
          <LogPage source={store} onIntent={onLogIntent} />
        </div>
        <div
          id="worktrees-panel"
          role="tabpanel"
          aria-labelledby="worktrees-tab"
          className={styles.page}
          hidden={activeView !== 'worktrees'}
        >
          <WorktreesPanel controller={controller} />
        </div>
      </div>
    </FileIconThemeProvider>
  );
}

function WorktreesPanel({ controller }: { controller: BrowserSession }) {
  const state = useBrowserSelector(controller.store, (state) => ({
    repositoryId: state.repository?.id ?? '',
    generation: state.generation,
    worktrees: state.worktrees,
    error: state.worktreesError,
    busy:
      state.worktreesLoading ||
      (state.operation?.section === 'worktrees' &&
        state.operation.phase === 'running'),
  }));

  return (
    <WorktreesPage
      key={state.repositoryId}
      {...state}
      onRequest={controller.request}
    />
  );
}
