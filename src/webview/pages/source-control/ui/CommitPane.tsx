import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type {
  SourceControlBridge,
  SourceControlRepository,
  SourceControlState,
} from '@contracts/source-control';
import { Icon, SplitHandle } from '@webview/shared/ui';

import { changeGroups, revealSection } from '../model/change-groups';
import { buildChangeTree, type ChangeNode } from '../model/file-tree';
import { folderKey, messageHeightLimits } from '../model/view-state';
import { CommitChangeGroup } from './CommitChangeGroup';
import { CommitMessageToolbar } from './CommitMessageToolbar';
import styles from './SourceControlPage.module.css';
import { SourceControlToolbar } from './SourceControlToolbar';

export function CommitPane({
  repository,
  busy,
  generating,
  bridge,
  collapsed,
  onCollapse,
  groupByDirectory,
  onGroupingChange,
  onExpandAll,
  reveal,
  hoverDelay,
  messageHeight,
  onMessageHeightChange,
}: {
  repository: SourceControlRepository | null;
  busy: boolean;
  generating: boolean;
  bridge: SourceControlBridge;
  collapsed: readonly string[];
  onCollapse(this: void, key: string, collapsed: boolean): void;
  groupByDirectory: boolean;
  onGroupingChange(this: void, group: boolean): void;
  onExpandAll(this: void, keys: string[], expand: boolean): void;
  reveal: SourceControlState['reveal'];
  hoverDelay: number;
  messageHeight: number;
  onMessageHeightChange(this: void, height: number): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(620);
  const [sessionId] = useState(() => crypto.randomUUID());
  const editSequence = useRef(0);
  const previousBusy = useRef(busy);
  const [draft, setDraft] = useState<{
    source: SourceControlRepository | null;
    value: string;
    pending: { id: string; value: string } | null;
  }>(() => ({
    source: repository,
    value: repository?.draft ?? '',
    pending: null,
  }));

  if (draft.source !== repository) {
    const incoming = repository?.draft ?? '';
    const pending =
      repository?.draftEditId === draft.pending?.id ? null : draft.pending;

    setDraft({
      source: repository,
      value: pending === null ? incoming : pending.value,
      pending,
    });
  }

  const repositoryId = repository?.info.id;

  useLayoutEffect(() => {
    const element = root.current;

    if (!element) return;
    const measure = () => {
      if (element.clientHeight > 0) setHeight(element.clientHeight);
    };

    measure();
    const observer = new ResizeObserver(measure);

    observer.observe(element);

    return () => observer.disconnect();
  }, []);
  const maximumHeight = Math.min(
    messageHeightLimits.max,
    Math.max(0, height - 64),
  );
  const minimumHeight = Math.min(messageHeightLimits.min, maximumHeight);
  const fittedHeight = Math.min(
    maximumHeight,
    Math.max(minimumHeight, messageHeight),
  );

  useEffect(() => {
    const wasBusy = previousBusy.current;

    previousBusy.current = busy;
    if (wasBusy && !busy && repositoryId && draft.pending)
      bridge.send({
        kind: 'message',
        repositoryId,
        message: draft.pending.value,
        editId: draft.pending.id,
      });
  }, [busy, repositoryId, draft.pending, bridge]);

  const files =
    repository?.changes.kind === 'ready' ? repository.changes.items : [];
  const groups = changeGroups(files);
  const checked = new Set(repository?.checked);
  const checkedFiles = [
    ...new Map(
      files
        .filter((file) => checked.has(file.path))
        .map((file) => [file.path, file]),
    ).values(),
  ];
  const count = checkedFiles.length;
  const disabled = busy || generating;
  const operation =
    groups.some((group) => group.section === 'merge') &&
    repository?.operation.kind === 'ready'
      ? repository.operation.items[0]
      : null;
  const canWrite =
    !!repository &&
    repository.changes.kind === 'ready' &&
    !disabled &&
    draft.pending === null &&
    (count > 0 || repository.commitMode.kind === 'amend') &&
    !!draft.value.trim();
  const canGenerate =
    !!repository && !disabled && draft.pending === null && count > 0;
  const expandAll = (expand: boolean) => {
    if (!repository) return;
    const keys: string[] = [];

    for (const group of groups) {
      const paths = [''];
      const collect = (nodes: ChangeNode<(typeof files)[number]>[]) => {
        for (const node of nodes)
          if (node.kind === 'folder') {
            paths.push(node.path);
            collect(node.children);
          }
      };

      collect(buildChangeTree(group.files));
      keys.push(
        ...paths.map((path) =>
          folderKey(repository.info.id, group.section, path),
        ),
      );
    }

    onExpandAll(keys, expand);
  };

  return (
    <div ref={root} className={styles.panel}>
      {repository && (
        <>
          <SourceControlToolbar
            kind="commit"
            operation={operation ?? null}
            onAbort={() => {
              if (operation)
                bridge.send({
                  kind: 'abort-operation',
                  repositoryId: repository.info.id,
                  token: operation.token,
                });
            }}
            disabled={disabled}
            canStash={!disabled && draft.pending === null && count > 0}
            groupByDirectory={groupByDirectory}
            onGroupingChange={onGroupingChange}
            onRefresh={() => bridge.send({ kind: 'refresh' })}
            onStash={() =>
              bridge.send({
                kind: 'stash-silently',
                repositoryId: repository.info.id,
              })
            }
            onReveal={() =>
              bridge.send({
                kind: 'reveal-working',
                repositoryId: repository.info.id,
              })
            }
            onExpand={() => expandAll(true)}
            onCollapse={() => expandAll(false)}
          />
          {repository.operation.kind === 'error' && (
            <p role="status" className={styles.empty}>
              {repository.operation.message}
            </p>
          )}
          <div className={styles.fileArea}>
            {repository.changes.kind === 'loading' && (
              <p role="status" className={styles.empty}>
                Loading changes…
              </p>
            )}
            {repository.changes.kind === 'ready' && !files.length && (
              <p className={styles.empty}>No changes.</p>
            )}
            {groups.map((group) => (
              <CommitChangeGroup
                key={group.section}
                repository={repository}
                files={group.files}
                section={group.section}
                label={group.label}
                checked={checked}
                collapsed={collapsed}
                disabled={disabled}
                groupByDirectory={groupByDirectory}
                hoverDelay={hoverDelay}
                bridge={bridge}
                onCollapse={onCollapse}
                reveal={
                  reveal?.repositoryId === repository.info.id &&
                  revealSection(files, reveal.path) === group.section
                    ? reveal
                    : null
                }
              />
            ))}
          </div>
        </>
      )}
      {repository && (
        <SplitHandle
          label="Resize commit message"
          orientation="horizontal"
          value={fittedHeight}
          min={minimumHeight}
          max={maximumHeight}
          direction={-1}
          onChange={onMessageHeightChange}
        />
      )}
      <div className={styles.messageArea} style={{ height: fittedHeight }}>
        <CommitMessageToolbar
          repository={repository}
          checkedFiles={checkedFiles}
          hoverDelay={hoverDelay}
          disabled={disabled || draft.pending !== null}
          generating={generating}
          canGenerate={canGenerate}
          bridge={bridge}
        />
        <textarea
          aria-label="Commit message"
          placeholder="Commit message"
          className={styles.message}
          rows={3}
          value={draft.value}
          maxLength={65536}
          disabled={!repository || busy}
          onChange={(event) => {
            if (repository && !busy) {
              const value = event.currentTarget.value.slice(0, 65536);
              const editId = `${sessionId}:${++editSequence.current}`;

              setDraft({
                source: repository,
                value,
                pending: { id: editId, value },
              });
              bridge.send({
                kind: 'message',
                repositoryId: repository.info.id,
                message: value,
                editId,
              });
            }
          }}
        />
        <div className={styles.commitActions}>
          <button
            type="button"
            className={styles.primary}
            disabled={!canWrite}
            onClick={() => {
              if (canWrite)
                bridge.send({
                  kind: 'commit',
                  repositoryId: repository.info.id,
                });
            }}
          >
            <Icon name="check" />
            {repository?.commitMode.kind === 'amend'
              ? 'Amend Commit'
              : 'Commit'}
          </button>
        </div>
        {generating && (
          <p role="status" className={styles.progress}>
            Generating message…
          </p>
        )}
      </div>
    </div>
  );
}
