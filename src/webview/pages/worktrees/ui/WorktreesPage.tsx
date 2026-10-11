import { useState } from 'react';
import { flushSync } from 'react-dom';

import type { RequestBody } from '@contracts/messages';
import type { WorktreeInfo } from '@contracts/model';
import {
  canDeleteWorktree,
  canOpenWorktree,
} from '@contracts/worktree-selection';
import {
  ActionButton,
  dispatchContextMenu,
  Icon,
  offsetPointerContextMenu,
} from '@webview/shared/ui';

import styles from './WorktreesPage.module.css';

export interface WorktreesPageProps {
  worktrees: readonly WorktreeInfo[];
  repositoryId?: string;
  generation?: number;
  onRequest(this: void, body: RequestBody): void;
}

function worktreePath(rootUri: string): string {
  const uri = new URL(rootUri);
  const path = decodeURIComponent(uri.pathname);

  return uri.hostname
    ? '//' + uri.hostname + path
    : path.replace(/^\/([a-z]:\/)/i, '$1');
}

export function WorktreesPage({
  worktrees,
  onRequest,
  repositoryId = '',
  generation = 0,
}: WorktreesPageProps) {
  const [selection, setSelection] = useState<{
    ids: string[];
    active: string;
    anchor: string;
  }>({
    ids: [],
    active: '',
    anchor: '',
  });
  const ids = selection.ids.filter((id) =>
    worktrees.some((item) => item.id === id),
  );
  const active = worktrees.some((item) => item.id === selection.active)
    ? selection.active
    : (ids.at(-1) ?? '');
  const anchor = worktrees.some((item) => item.id === selection.anchor)
    ? selection.anchor
    : '';

  if (
    ids.length !== selection.ids.length ||
    active !== selection.active ||
    anchor !== selection.anchor
  )
    setSelection({ ...selection, ids, active, anchor });
  const selected = worktrees.filter((item) => ids.includes(item.id));
  const single = selected.length === 1 ? selected[0] : undefined;
  const openable = !!single && canOpenWorktree(single);
  const deletable =
    selected.length > 0 &&
    selected.length <= 400 &&
    selected.every(canDeleteWorktree);
  const entry =
    active || worktrees.find((item) => item.current)?.id || worktrees[0]?.id;
  const open = (item: WorktreeInfo, newWindow: boolean) => {
    if (canOpenWorktree(item))
      onRequest({ kind: 'open-worktree', worktreeId: item.id, newWindow });
  };

  const remove = () => {
    if (deletable)
      onRequest({
        kind: 'action',
        action: {
          kind: 'delete-worktrees',
          worktreeIds: selected.map((item) => item.id),
        },
      });
  };

  const choose = (id: string, range = false, toggle = false) => {
    let next: string[];
    const anchor = worktrees.findIndex((item) => item.id === selection.anchor);
    const end = worktrees.findIndex((item) => item.id === id);

    if (range && anchor >= 0)
      next = worktrees
        .slice(Math.min(anchor, end), Math.max(anchor, end) + 1)
        .map((item) => item.id);
    else if (toggle)
      next = ids.includes(id)
        ? ids.filter((value) => value !== id)
        : [...ids, id];
    else next = [id];
    setSelection({
      ids: next,
      active: id,
      anchor: range && anchor >= 0 ? selection.anchor : id,
    });
  };

  return (
    <section id="worktrees-view" className={styles.page} aria-label="Worktrees">
      <div
        className={styles.toolbar}
        role="toolbar"
        aria-label="Worktree actions"
        aria-orientation="vertical"
      >
        <ActionButton
          className={styles.action}
          label="Refresh Worktrees"
          icon="sync"
          onClick={() => onRequest({ kind: 'worktrees', retry: true })}
        />
        <div className={styles.separator} />
        <ActionButton
          className={styles.action}
          label="Create Worktree"
          icon="add"
          onClick={() =>
            onRequest({ kind: 'action', action: { kind: 'create-worktree' } })
          }
        />
      </div>
      <div className={styles.content}>
        <div
          className={styles.grid}
          role="grid"
          aria-label="Existing worktrees"
          aria-multiselectable="true"
          aria-colcount={3}
          aria-rowcount={worktrees.length + 1}
        >
          <div role="row" className={styles.columns} aria-rowindex={1}>
            {['Worktree', 'Branch', 'Path'].map((label) => (
              <span key={label} role="columnheader">
                {label}
              </span>
            ))}
          </div>
          {worktrees.map((item, index) => {
            const branch = item.branch ?? 'Detached HEAD';
            const path = worktreePath(item.rootUri);

            return (
              <div
                key={item.id}
                role="row"
                className={styles.row}
                data-worktree={item.id}
                data-current={item.current}
                data-available={item.available}
                tabIndex={entry === item.id ? 0 : -1}
                aria-rowindex={index + 2}
                aria-selected={ids.includes(item.id)}
                aria-label={[
                  item.name,
                  branch,
                  ...(item.current ? ['current'] : []),
                  ...(item.available ? [] : ['unavailable']),
                  path,
                ].join(' · ')}
                data-vscode-context={JSON.stringify({
                  webviewSection: 'worktree',
                  preventDefaultContextMenuItems: true,
                  repositoryId: repositoryId,
                  generation: generation,
                  worktreeId: item.id,
                  worktreeIds: ids.includes(item.id) ? ids : [item.id],
                  worktreeSelectionCount: ids.includes(item.id)
                    ? ids.length
                    : 1,
                  worktreeCanOpen: ids.includes(item.id)
                    ? openable
                    : canOpenWorktree(item),
                  worktreeCanDelete: ids.includes(item.id)
                    ? deletable
                    : canDeleteWorktree(item),
                })}
                onClick={(event) =>
                  choose(
                    item.id,
                    event.shiftKey,
                    event.metaKey || event.ctrlKey,
                  )
                }
                onDoubleClick={() => open(item, true)}
                onContextMenu={(event) => {
                  if (!ids.includes(item.id)) flushSync(() => choose(item.id));
                  event.currentTarget.focus();
                  offsetPointerContextMenu(
                    event.nativeEvent,
                    event.currentTarget,
                  );
                }}
                onKeyDown={(event) => {
                  if (event.key === ' ') {
                    event.preventDefault();
                    choose(
                      item.id,
                      event.shiftKey,
                      event.metaKey || event.ctrlKey,
                    );
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    if (selected.length <= 1) open(item, true);
                  } else if (event.key === 'Delete') {
                    event.preventDefault();
                    remove();
                  } else if (
                    event.key === 'ArrowUp' ||
                    event.key === 'ArrowDown'
                  ) {
                    event.preventDefault();
                    const next =
                      worktrees[index + (event.key === 'ArrowDown' ? 1 : -1)];

                    if (next) {
                      choose(next.id, event.shiftKey);
                      [
                        ...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                          '[data-worktree]',
                        ) ?? []),
                      ]
                        .find((row) => row.dataset.worktree === next.id)
                        ?.focus();
                    }
                  } else if (
                    event.key === 'ContextMenu' ||
                    (event.shiftKey && event.key === 'F10')
                  ) {
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();

                    dispatchContextMenu(
                      event.currentTarget,
                      bounds.x + 8,
                      bounds.y + 8,
                    );
                  }
                }}
              >
                <span role="gridcell" className={styles.name} title={item.name}>
                  <span className={styles.marker} aria-hidden="true">
                    {item.current && <Icon name="check" />}
                  </span>
                  <span>{item.name}</span>
                  {!item.available && (
                    <span className={styles.unavailable}>Unavailable</span>
                  )}
                  {item.locked && <Icon name="lock" />}
                </span>
                <span role="gridcell" title={branch}>
                  {branch}
                </span>
                <span role="gridcell" className={styles.path} title={path}>
                  {path}
                </span>
              </div>
            );
          })}
        </div>
        {!worktrees.length && (
          <p className={styles.empty}>No worktrees to show.</p>
        )}
      </div>
    </section>
  );
}
