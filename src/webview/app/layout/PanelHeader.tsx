import { classifySearch } from '@contracts/search';
import { Icon } from '@webview/shared/ui';

import type { BrowserController } from '../model/useBrowserState';
import styles from './PanelHeader.module.css';

const setupGuidance = {
  untrusted: 'Trust this workspace through VS Code to use Git.',
  'git-disabled':
    'Enable the built-in Git extension and Git in VS Code settings, and install Git.',
  'no-repository': 'Open a folder containing a Git repository.',
};

export function PanelHeader({
  state,
  request,
  setActiveView,
}: BrowserController) {
  const scope =
    !state.filters.regex && classifySearch(state.text) === 'hash-and-text'
      ? 'All branches search · ' + state.text
      : state.scope.kind === 'head'
        ? (state.repository?.branch ?? 'Detached HEAD')
        : state.scope.kind === 'all'
          ? 'All branches'
          : state.scope.kind === 'commit'
            ? 'Commit ' + state.scope.sha.slice(0, 8)
            : (state.refs.find(
                (ref) =>
                  ref.id ===
                  (state.scope.kind === 'ref' ? state.scope.refId : ''),
              )?.name ?? 'Reference');
  const logLabel =
    'Log' +
    (state.repository
      ? ': ' +
        (state.repositories.length > 1 ? state.repository.label + ' · ' : '') +
        scope
      : '');
  const status =
    state.activeView === 'log' && state.loading
      ? 'Loading history…'
      : state.setup !== 'ready'
        ? setupGuidance[state.setup]
        : state.activeView === 'log' &&
            state.commits.length === 0 &&
            !state.error
          ? 'No commits in these results.'
          : '';

  return (
    <header className={styles.header}>
      <div role="tablist" aria-label="Git views">
        {(['log', 'worktrees'] as const).map((view) => (
          <button
            key={view}
            role="tab"
            id={view + '-tab'}
            className={view === 'log' ? styles.logTab : undefined}
            aria-label={view === 'log' ? 'Log' : 'Worktrees'}
            title={view === 'log' ? logLabel : 'Worktrees'}
            aria-description={view === 'log' ? logLabel : undefined}
            aria-selected={state.activeView === view}
            onClick={() => setActiveView(view)}
          >
            {view === 'log' ? (
              <>
                <span className={styles.tabName}>
                  Log{state.repository ? ': ' : ''}
                </span>
                {state.repository && (
                  <span className={styles.tabContext}>
                    {state.repositories.length > 1 &&
                      state.repository.label + ' · '}
                    <span id="scope">{scope}</span>
                  </span>
                )}
              </>
            ) : (
              'Worktrees'
            )}
          </button>
        ))}
      </div>
      <div className={styles.context}>
        <div
          id="status"
          className={
            state.activeView === 'log' && state.loading
              ? styles.loading
              : styles.status
          }
          role="status"
          hidden={!status}
          title={status}
        >
          {status}
        </div>
      </div>
      {state.repositories.length > 1 && (
        <button
          id="repository"
          className={styles.repository}
          aria-label="Select repository"
          aria-description={
            'Current repository: ' + (state.repository?.label ?? '')
          }
          title={'Select repository · ' + (state.repository?.label ?? '')}
          onClick={() => request({ kind: 'choose-repository' })}
        >
          <Icon name="repo" />
          <span>{state.repository?.label ?? 'Select Repository'}</span>
          <Icon name="chevron-down" />
        </button>
      )}
      {state.setup === 'untrusted' && (
        <button
          id="trust"
          className={styles.icon}
          aria-label="Workspace Trust"
          title="Workspace Trust"
          onClick={() => request({ kind: 'trust' })}
        >
          <Icon name="trust" />
        </button>
      )}
    </header>
  );
}
