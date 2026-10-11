import { useEffect, useRef, useState } from 'react';

import type {
  SourceControlBridge,
  SourceControlRepository,
  SourceControlState,
} from '@contracts/source-control';
import { ActionButton, folderDecoration, Icon } from '@webview/shared/ui';

import { fileDecoration } from '../model/file-status';
import { buildChangeTree, type ChangeNode } from '../model/file-tree';
import { folderKey } from '../model/view-state';
import { ChangeTree } from './ChangeTree';
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
}) {
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
  const checked = new Set(repository?.checked);
  const count = files.filter((file) => checked.has(file.path)).length;
  const disabled = busy || generating;
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
    const paths = [''];
    const collect = (nodes: ChangeNode<(typeof files)[number]>[]) => {
      for (const node of nodes)
        if (node.kind === 'folder') {
          paths.push(node.path);
          collect(node.children);
        }
    };

    collect(buildChangeTree(files));
    onExpandAll(
      paths.map((path) => folderKey(repository.info.id, 'working', path)),
      expand,
    );
  };

  return (
    <>
      {repository && (
        <>
          <SourceControlToolbar
            kind="commit"
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
          <div className={styles.fileArea}>
            {repository.changes.kind === 'loading' && (
              <p role="status" className={styles.empty}>
                Loading changes…
              </p>
            )}
            {repository.changes.kind === 'ready' && !files.length && (
              <p className={styles.empty}>No changes.</p>
            )}
            <ChangeTree
              files={files}
              pathLabel={repository.pathLabel}
              hoverDelay={hoverDelay}
              label="Changes"
              root="Changes"
              groupByDirectory={groupByDirectory}
              reveal={
                reveal?.repositoryId === repository.info.id ? reveal : null
              }
              checked={checked}
              collapsed={collapsed}
              disabled={disabled}
              fileKey={(file) => file.path}
              folderKey={(path) =>
                folderKey(repository.info.id, 'working', path)
              }
              onCollapse={onCollapse}
              onCheck={(items, checked) => {
                if (!disabled)
                  bridge.send({
                    kind: 'check',
                    repositoryId: repository.info.id,
                    paths: items.map((file) => file.path),
                    checked,
                  });
              }}
              onOpen={(file) =>
                bridge.send({
                  kind: 'open-working',
                  repositoryId: repository.info.id,
                  path: file.path,
                  index: !file.working && file.staged,
                })
              }
              context={(file, selected) =>
                JSON.stringify({
                  webviewSection: 'working-change',
                  preventDefaultContextMenuItems: true,
                  repositoryId: repository.info.id,
                  path: file.path,
                  paths: selected.map((item) => item.path),
                  copyPaths: selected.map((item) => item.path),
                  staged: selected.some((item) => item.staged),
                  working: selected.every((item) => item.working),
                  conflict: selected.some(
                    (item) =>
                      fileDecoration(item.status, item.untracked).kind ===
                      'conflict',
                  ),
                  changeSelectionCount: selected.length,
                  index: !file.working && file.staged,
                })
              }
              folderContext={(path, selected) =>
                JSON.stringify({
                  webviewSection: 'working-change',
                  preventDefaultContextMenuItems: true,
                  repositoryId: repository.info.id,
                  path,
                  paths: selected.map((file) => file.path),
                  copyPaths: path ? [path] : selected.map((file) => file.path),
                  staged: selected.some((file) => file.staged),
                  working: selected.every((file) => file.working),
                  conflict: selected.some(
                    (file) =>
                      fileDecoration(file.status, file.untracked).kind ===
                      'conflict',
                  ),
                  changeSelectionCount: selected.length,
                })
              }
              actions={(file) =>
                file.working &&
                fileDecoration(file.status, file.untracked).kind !==
                  'conflict' ? (
                  <ActionButton
                    label="Discard Changes"
                    icon="discard"
                    disabled={disabled}
                    onClick={() =>
                      bridge.send({
                        kind: 'discard-working',
                        repositoryId: repository.info.id,
                        path: file.path,
                      })
                    }
                  />
                ) : null
              }
              decoration={(file) => fileDecoration(file.status, file.untracked)}
              folderDecoration={(files) =>
                folderDecoration(
                  files.map((file) =>
                    fileDecoration(file.status, file.untracked),
                  ),
                )
              }
            />
          </div>
        </>
      )}
      <div className={styles.messageArea}>
        <CommitMessageToolbar
          repository={repository}
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
    </>
  );
}
