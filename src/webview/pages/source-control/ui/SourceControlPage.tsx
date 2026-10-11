import { useEffect, useRef, useState } from 'react';

import type {
  SourceControlBridge,
  SourceControlState,
  SourceControlTab,
} from '@contracts/source-control';

import { folderKey, messageHeightLimits, readView } from '../model/view-state';
import { CommitPane } from './CommitPane';
import styles from './SourceControlPage.module.css';
import { StashesPane } from './StashesPane';

export function SourceControlPage({ bridge }: { bridge: SourceControlBridge }) {
  const [view, setView] = useState(() => readView(bridge.getState()));
  const [state, setState] = useState<SourceControlState | null>(null);
  const handledReveal = useRef(0);
  const tab = state?.tab ?? view.tab;
  const repository =
    state?.repositories.find((item) => item.info.id === state.repositoryId) ??
    null;

  useEffect(() => {
    const stop = bridge.subscribe((response) => {
      setState(response.state);
      const reveal = response.state.reveal;
      const shouldReveal =
        reveal &&
        reveal.repositoryId === response.state.repositoryId &&
        reveal.sequence !== handledReveal.current;

      if (shouldReveal) handledReveal.current = reveal.sequence;
      setView((previous) => {
        let collapsed = previous.collapsed;

        if (shouldReveal) {
          const parts = reveal.path.split('/');
          const keys = new Set([
            folderKey(reveal.repositoryId, 'working', ''),
            ...parts
              .slice(0, -1)
              .map((_, index) =>
                folderKey(
                  reveal.repositoryId,
                  'working',
                  parts.slice(0, index + 1).join('/'),
                ),
              ),
          ]);

          collapsed = collapsed.filter((key) => !keys.has(key));
        }

        return previous.repositoryId === response.state.repositoryId &&
          previous.tab === response.state.tab &&
          collapsed === previous.collapsed
          ? previous
          : {
              ...previous,
              collapsed,
              repositoryId: response.state.repositoryId,
              tab: response.state.tab,
            };
      });
    });
    const saved = readView(bridge.getState());

    bridge.send({
      kind: 'ready',
      repositoryId: saved.repositoryId,
      tab: saved.tab,
    });

    return stop;
  }, [bridge]);
  useEffect(() => {
    bridge.setState(view);
  }, [bridge, view]);
  const chooseTab = (next: SourceControlTab) => {
    if (!state?.busy && next !== tab) bridge.send({ kind: 'tab', tab: next });
  };

  const collapse = (key: string, collapsed: boolean) => {
    setView((previous) => ({
      ...previous,
      collapsed: collapsed
        ? [...new Set([...previous.collapsed, key])]
        : previous.collapsed.filter((item) => item !== key),
    }));
  };

  const group = (groupByDirectory: boolean) => {
    setView((previous) => ({
      ...previous,
      groupByDirectory,
      collapsed: previous.collapsed.filter(
        (key) => key !== folderKey(repository?.info.id ?? '', 'working', ''),
      ),
    }));
  };

  return (
    <section
      aria-label="Source Control"
      data-source-control
      className={styles.page}
      data-vscode-context={JSON.stringify({
        webviewSection: 'source-control',
        preventDefaultContextMenuItems: true,
        repositoryId: repository?.info.id ?? null,
      })}
    >
      <header className={styles.header}>
        <div
          role="tablist"
          aria-label="Source Control views"
          className={styles.tabs}
          onKeyDown={(event) => {
            if (
              !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) ||
              state?.busy
            )
              return;
            event.preventDefault();
            const next =
              event.key === 'Home'
                ? 'commit'
                : event.key === 'End'
                  ? 'stash'
                  : tab === 'commit'
                    ? 'stash'
                    : 'commit';

            chooseTab(next);
            event.currentTarget
              .querySelector<HTMLElement>(`[data-tab="${next}"]`)
              ?.focus();
          }}
        >
          {(['commit', 'stash'] satisfies SourceControlTab[]).map((value) => (
            <button
              type="button"
              key={value}
              id={`source-control-${value}-tab`}
              role="tab"
              data-tab={value}
              aria-controls={`source-control-${value}`}
              aria-selected={value === tab}
              tabIndex={value === tab ? 0 : -1}
              disabled={state?.busy}
              className={styles.tab}
              onClick={() => chooseTab(value)}
            >
              {value === 'commit' ? 'Commit' : 'Stashes'}
            </button>
          ))}
        </div>
      </header>
      {!!state && state.repositories.length > 1 && (
        <label className={styles.repository}>
          <span className={styles.srOnly}>Repository</span>
          <select
            aria-label="Repository"
            value={repository?.info.id ?? ''}
            disabled={state.busy}
            onChange={(event) => {
              if (event.currentTarget.value)
                bridge.send({
                  kind: 'repository',
                  repositoryId: event.currentTarget.value,
                });
            }}
          >
            <option value="" disabled>
              Select repository
            </option>
            {state.repositories.map((item) => (
              <option key={item.info.id} value={item.info.id}>
                {item.info.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {!state && (
        <p role="status" className={styles.empty}>
          Loading source control…
        </p>
      )}
      {!!state && !state.repositories.length && (
        <p className={styles.empty}>No Git repositories found.</p>
      )}
      {!!state && state.repositories.length > 0 && !repository && (
        <p className={styles.empty}>Select a repository to continue.</p>
      )}
      <div
        id="source-control-commit"
        role="tabpanel"
        aria-labelledby="source-control-commit-tab"
        hidden={tab !== 'commit'}
        className={styles.panel}
      >
        <CommitPane
          hoverDelay={state?.hoverDelay ?? 500}
          key={repository?.info.id ?? 'no-repository'}
          repository={repository}
          busy={!state || state.busy}
          generating={state?.generating ?? false}
          messageHeight={view.messageHeight}
          onMessageHeightChange={(messageHeight) =>
            setView((previous) => ({
              ...previous,
              messageHeight: Math.max(messageHeightLimits.min, messageHeight),
            }))
          }
          bridge={bridge}
          collapsed={view.collapsed}
          onCollapse={collapse}
          groupByDirectory={view.groupByDirectory}
          onGroupingChange={group}
          onExpandAll={(keys, expand) =>
            setView((previous) => ({
              ...previous,
              collapsed: expand
                ? previous.collapsed.filter((key) => !keys.includes(key))
                : [...new Set([...previous.collapsed, ...keys])],
            }))
          }
          reveal={state?.reveal ?? null}
        />
      </div>
      <div
        id="source-control-stash"
        role="tabpanel"
        aria-labelledby="source-control-stash-tab"
        hidden={tab !== 'stash'}
        className={styles.panel}
      >
        {repository && (
          <StashesPane
            hoverDelay={state?.hoverDelay ?? 500}
            key={repository.info.id}
            repository={repository}
            active={tab === 'stash'}
            disabled={!state || state.busy || state.generating}
            bridge={bridge}
            collapsed={view.collapsed}
            onCollapse={collapse}
            expanded={view.expandedStashes}
            groupByDirectory={view.groupByDirectory}
            onGroupingChange={group}
            onExpandAll={(stashes, directories, open) =>
              setView((previous) => ({
                ...previous,
                expandedStashes: open
                  ? [...new Set([...previous.expandedStashes, ...stashes])]
                  : previous.expandedStashes.filter(
                      (key) => !stashes.includes(key),
                    ),
                collapsed: open
                  ? previous.collapsed.filter(
                      (key) => !directories.includes(key),
                    )
                  : [...new Set([...previous.collapsed, ...directories])],
              }))
            }
            onExpand={(key, open) =>
              setView((previous) => ({
                ...previous,
                expandedStashes: open
                  ? [...new Set([...previous.expandedStashes, key])]
                  : previous.expandedStashes.filter((item) => item !== key),
              }))
            }
          />
        )}
      </div>
    </section>
  );
}
