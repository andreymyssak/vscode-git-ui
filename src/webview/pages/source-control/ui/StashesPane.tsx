import { useEffect, useId, useState } from 'react';

import type {
  SourceControlBridge,
  SourceControlRepository,
  StashEntry,
  StashFile,
  StashFileKey,
} from '@contracts/source-control';
import { Icon, PathHint } from '@webview/shared/ui';

import { fileDecoration } from '../model/file-status';
import { folderKey } from '../model/view-state';
import { ChangeTree } from './ChangeTree';
import styles from './SourceControlPage.module.css';
import { SourceControlToolbar } from './SourceControlToolbar';

interface Props {
  repository: SourceControlRepository;
  active: boolean;
  hoverDelay: number;
  disabled: boolean;
  bridge: SourceControlBridge;
  collapsed: readonly string[];
  expanded: readonly string[];
  groupByDirectory: boolean;
  onGroupingChange(this: void, group: boolean): void;
  onCollapse(this: void, key: string, collapsed: boolean): void;
  onExpand(this: void, key: string, expanded: boolean): void;
  onExpandAll(
    this: void,
    stashes: string[],
    directories: string[],
    expanded: boolean,
  ): void;
}

type Selection = { sha: string } & (
  { kind: 'stash' } | { kind: 'files'; keys: string[] }
);

const snapshots = [
  'working',
  'index',
  'untracked',
] satisfies StashFile['snapshot'][];
const snapshotLabels = {
  working: 'Working files',
  index: 'Staged files',
  untracked: 'Untracked files',
} satisfies Record<StashFile['snapshot'], string>;
const fileKey = (file: StashFileKey) =>
  JSON.stringify([file.snapshot, file.path]);
const requestKey = (file: StashFile): StashFileKey => ({
  path: file.path,
  snapshot: file.snapshot,
});

export function StashesPane(props: Props) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const stashes = props.repository.stashes;
  const items = stashes.kind === 'ready' ? stashes.items : [];
  const selectedStash = items.find((item) => item.sha === selection?.sha);
  const selectedFiles =
    selection?.kind === 'files' && selectedStash?.files?.kind === 'ready'
      ? selectedStash.files.items
          .filter((file) => selection.keys.includes(fileKey(file)))
          .map(requestKey)
      : [];
  const canApplyStash =
    !!selectedStash &&
    (selection?.kind === 'stash' || selectedFiles.length > 0);
  const expandAll = (open: boolean) => {
    const directoryKeys = new Set<string>();

    for (const stash of items) {
      if (stash.files?.kind !== 'ready') continue;
      for (const file of stash.files.items) {
        const parts = file.path.split('/');

        for (let index = 1; index < parts.length; index++)
          directoryKeys.add(
            folderKey(
              props.repository.info.id,
              `stash:${stash.sha}:${file.snapshot}`,
              parts.slice(0, index).join('/'),
            ),
          );
      }
    }

    // Include saved collapsed folders whose files are still loading after refresh.
    const prefixes = items.flatMap((stash) =>
      snapshots.map(
        (snapshot) =>
          `${JSON.stringify([props.repository.info.id, `stash:${stash.sha}:${snapshot}`]).slice(0, -1)},`,
      ),
    );

    for (const key of props.collapsed)
      if (prefixes.some((prefix) => key.startsWith(prefix)))
        directoryKeys.add(key);
    props.onExpandAll(
      items.map((stash) =>
        folderKey(props.repository.info.id, 'stash', stash.sha),
      ),
      [...directoryKeys],
      open,
    );
  };

  return (
    <>
      <SourceControlToolbar
        kind="stash"
        disabled={props.disabled}
        hasStashes={items.length > 0}
        canApplyStash={canApplyStash}
        groupByDirectory={props.groupByDirectory}
        onGroupingChange={props.onGroupingChange}
        onRefresh={() => props.bridge.send({ kind: 'refresh' })}
        onApplyStash={() => {
          if (props.disabled || !canApplyStash || !selectedStash) return;
          if (selection?.kind === 'stash')
            props.bridge.send({
              kind: 'restore-stash',
              repositoryId: props.repository.info.id,
              sha: selectedStash.sha,
            });
          else
            props.bridge.send({
              kind: 'restore-stash-files',
              repositoryId: props.repository.info.id,
              sha: selectedStash.sha,
              files: selectedFiles,
            });
        }}
        onExpand={() => expandAll(true)}
        onCollapse={() => expandAll(false)}
      />
      {stashes.kind === 'loading' && (
        <p role="status" className={styles.empty}>
          Loading stashes…
        </p>
      )}
      {stashes.kind === 'ready' && !items.length && (
        <p className={styles.empty}>No stashes.</p>
      )}
      <div className={styles.stashes} aria-label="Stashes">
        {items.map((stash) => (
          <StashCard
            key={stash.sha}
            {...props}
            stash={stash}
            selection={selection?.sha === stash.sha ? selection : null}
            onSelect={setSelection}
          />
        ))}
      </div>
    </>
  );
}

function StashCard({
  stash,
  repository,
  active,
  disabled,
  bridge,
  collapsed,
  expanded,
  onExpand,
  onCollapse,
  groupByDirectory,
  hoverDelay,
  selection,
  onSelect,
}: Props & {
  stash: StashEntry;
  selection: Selection | null;
  onSelect(this: void, value: Selection): void;
}) {
  const id = useId();
  const key = folderKey(repository.info.id, 'stash', stash.sha);
  const open = expanded.includes(key);
  const files = stash.files?.kind === 'ready' ? stash.files.items : [];
  const checked = new Set(selection?.kind === 'files' ? selection.keys : []);
  const groups = snapshots.filter((snapshot) =>
    files.some((file) => file.snapshot === snapshot),
  );
  const title = stash.message.split(/[\r\n]/, 1)[0]?.trim() || 'Changes';
  const date = new Date(stash.date);
  const formattedDate = Number.isNaN(date.getTime())
    ? stash.date
    : date.toLocaleString();

  useEffect(() => {
    if (active && open && !disabled && stash.files === null)
      bridge.send({
        kind: 'load-stash',
        repositoryId: repository.info.id,
        sha: stash.sha,
      });
  }, [
    active,
    open,
    disabled,
    stash.files,
    stash.sha,
    repository.info.id,
    bridge,
  ]);
  const check = (items: StashFile[], value: boolean) => {
    if (disabled) return;
    const next = new Set(checked);

    for (const file of items)
      if (value) next.add(fileKey(file));
      else next.delete(fileKey(file));
    onSelect({ sha: stash.sha, kind: 'files', keys: [...next] });
  };

  return (
    <section
      className={styles.stash}
      data-stash={stash.sha}
      aria-label={title}
      data-vscode-context={JSON.stringify({
        webviewSection: 'stash',
        preventDefaultContextMenuItems: true,
        repositoryId: repository.info.id,
        sha: stash.sha,
      })}
    >
      <div className={styles.stashHeader} data-selected={selection !== null}>
        <button
          type="button"
          className={styles.stashToggle}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
          aria-expanded={open}
          aria-pressed={selection?.kind === 'stash'}
          aria-controls={id}
          disabled={disabled}
          onClick={() => {
            onSelect({ sha: stash.sha, kind: 'stash' });
            onExpand(key, !open);
            if (!open && !disabled && stash.files?.kind === 'error')
              bridge.send({
                kind: 'load-stash',
                repositoryId: repository.info.id,
                sha: stash.sha,
              });
          }}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <Icon name="archive" />
          <PathHint
            delay={hoverDelay}
            text={`${title}\n${stash.selector}\n${formattedDate}`}
          >
            {title}
          </PathHint>
        </button>
      </div>
      {open && (
        <div id={id} className={styles.stashContent}>
          <p className={styles.stashMetadata} title={formattedDate}>
            {stash.selector}
            <span>{formattedDate}</span>
          </p>
          {(!stash.files || stash.files.kind === 'loading') && (
            <p role="status" className={styles.empty}>
              Loading saved files…
            </p>
          )}
          {stash.files?.kind === 'ready' && !files.length && (
            <p className={styles.empty}>No saved files.</p>
          )}
          {groups.map((snapshot) => (
            <div key={snapshot}>
              {groups.length > 1 && (
                <div className={styles.snapshotHeader}>
                  {snapshotLabels[snapshot]}
                </div>
              )}
              <ChangeTree<StashFile>
                pathLabel={repository.pathLabel}
                hoverDelay={hoverDelay}
                files={files.filter((file) => file.snapshot === snapshot)}
                label={
                  groups.length > 1 ? snapshotLabels[snapshot] : 'Saved files'
                }
                snapshot={snapshot}
                checked={checked}
                collapsed={collapsed}
                groupByDirectory={groupByDirectory}
                disabled={disabled}
                fileKey={fileKey}
                folderKey={(path) =>
                  folderKey(
                    repository.info.id,
                    `stash:${stash.sha}:${snapshot}`,
                    path,
                  )
                }
                onCollapse={onCollapse}
                onCheck={check}
                onOpen={(file) => {
                  if (selection?.kind !== 'files')
                    onSelect({ sha: stash.sha, kind: 'files', keys: [] });
                  bridge.send({
                    kind: 'open-stash-file',
                    repositoryId: repository.info.id,
                    sha: stash.sha,
                    file: requestKey(file),
                  });
                }}
                context={(file, selected) =>
                  JSON.stringify({
                    webviewSection: 'stash-file',
                    preventDefaultContextMenuItems: true,
                    repositoryId: repository.info.id,
                    sha: stash.sha,
                    file: requestKey(file),
                    files: selected.map(requestKey),
                    copyPaths: selected.map((item) => item.path),
                    changeSelectionCount: selected.length,
                  })
                }
                folderContext={(path, selected) =>
                  JSON.stringify({
                    webviewSection: 'stash-file',
                    preventDefaultContextMenuItems: true,
                    repositoryId: repository.info.id,
                    sha: stash.sha,
                    files: selected.map(requestKey),
                    copyPaths: path
                      ? [path]
                      : selected.map((file) => file.path),
                    changeSelectionCount: selected.length,
                  })
                }
                decoration={(file) =>
                  fileDecoration(file.status, file.snapshot === 'untracked')
                }
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
