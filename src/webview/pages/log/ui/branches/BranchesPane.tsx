import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ActionButton, Icon } from '@webview/shared/ui';

import {
  buildBranchTree,
  currentBranchAncestors,
  resolveExpansion,
} from '../../model/branch-tree-state';
import type { LogData, LogIntent } from '../../model/view';
import styles from './BranchesPane.module.css';
import type { TreeMemory } from './BranchTree';
import { BranchTree } from './BranchTree';

const emptyExpansion: ReadonlyMap<string, boolean> = new Map();

export function BranchesPane({
  data,
  onIntent,
}: {
  data: LogData;
  onIntent(this: void, intent: LogIntent): void;
}) {
  // The typed custom-element boundary owns mutable focus/scroll cells, not React data.
  'use no memo';
  const id = data.repository?.id ?? '';
  const branch = data.repository?.branch ?? null;
  const fetching =
    data.operation?.section === 'branches' &&
    data.operation.phase === 'running' &&
    data.operation.refIds.length === 0;
  const fetchQueued =
    (data.operation?.phase === 'waiting' &&
      data.operation.section === 'branches' &&
      data.operation.refIds.length === 0) ||
    (data.operation?.queued?.some(
      (operation) =>
        operation.section === 'branches' && operation.refIds.length === 0,
    ) ??
      false);
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [expansions, setExpansions] = useState<
    Map<string, Map<string, boolean>>
  >(new Map());
  const memories = useRef(
    new Map<string, React.MutableRefObject<TreeMemory>>(),
  );
  const previousBranches = useRef(new Map<string, string | null>());
  const [selection, setSelection] = useState<{
    repositoryId: string;
    activeId: string | null;
    refIds: string[];
  } | null>(null);
  const [reveal, setReveal] = useState<{
    repositoryId: string;
    refId: string;
    sequence: number;
  } | null>(null);
  const query = queries[id] ?? '';
  const nodes = useMemo(
    () => buildBranchTree(data.refs, branch, query),
    [data.refs, branch, query],
  );
  const remembered = expansions.get(id) ?? emptyExpansion;
  const previous = previousBranches.current.get(id);

  useEffect(() => {
    const previous = previousBranches.current.get(id);

    previousBranches.current.set(id, branch);
    if (previous !== undefined && previous !== branch)
      setExpansions((old) => {
        const next = new Map(old);
        const remembered = new Map(old.get(id));

        for (const ancestor of currentBranchAncestors(branch))
          remembered.set(ancestor, true);
        next.set(id, remembered);

        return next;
      });
  }, [id, branch]);
  const expanded = useMemo(() => {
    const next = new Map(remembered);

    if (previous !== undefined && previous !== branch)
      for (const ancestor of currentBranchAncestors(branch))
        next.set(ancestor, true);

    return resolveExpansion(nodes, next, branch, !!query.trim());
  }, [nodes, remembered, branch, previous, query]);
  const visibleIds = useMemo(() => {
    const ids = new Set<string>();
    const visit = (node: (typeof nodes)[number]) => {
      if (node.reference) ids.add(node.reference.id);
      if (expanded.get(node.id))
        for (const child of node.children) visit(child);
    };

    for (const node of nodes) visit(node);

    return ids;
  }, [nodes, expanded]);
  const selectedRefIds = useMemo(() => {
    const owned =
      selection?.repositoryId === id &&
      (selection.activeId === data.selectedRefId ||
        !data.refs.some((ref) => ref.id === selection.activeId));
    const ids = owned
      ? selection.refIds
      : data.selectedRefId
        ? [data.selectedRefId]
        : [];

    return ids.filter(
      (refId) =>
        data.refs.some((ref) => ref.id === refId) &&
        (ids.length === 1 || visibleIds.has(refId)),
    );
  }, [selection, id, data.selectedRefId, data.refs, visibleIds]);

  // Reconcile this component's transient group before rendering stale targets.
  if (reveal && reveal.repositoryId !== id) setReveal(null);
  if (selection && selection.repositoryId !== id) setSelection(null);
  else if (
    selection?.repositoryId === id &&
    selection.refIds.length > 1 &&
    (selection.refIds.length !== selectedRefIds.length ||
      selection.refIds.some((refId, index) => refId !== selectedRefIds[index]))
  )
    setSelection({
      repositoryId: id,
      activeId: data.selectedRefId,
      refIds: selectedRefIds,
    });

  if (!memories.current.has(id))
    memories.current.set(id, {
      current: {
        focusKey: '',
        wantFocus: false,
        scrollTop: 0,
        scrollLeft: 0,
        scrollEpoch: 0,
      },
    });
  const memory = memories.current.get(id)!;
  // Record the checked-out path only after the tree has committed it.
  const onExpansion = useCallback(
    (nodeId: string, open: boolean) => {
      if (query.trim()) return;
      setExpansions((old) => {
        const current = old.get(id) ?? new Map<string, boolean>();

        if (current.get(nodeId) === open) return old;
        const next = new Map(old);

        next.set(id, new Map(current).set(nodeId, open));

        return next;
      });
    },
    [id, query],
  );
  const search = useRef<HTMLInputElement>(null);
  const currentRef = data.refs.find(
    (ref) => ref.kind === 'local' && ref.name === branch,
  );

  return (
    <aside id="branch-pane" className={styles.pane}>
      <div
        id="branch-visibility"
        className={
          data.branchesCollapsed ? styles.collapsedRail : styles.headerRail
        }
        role="toolbar"
        aria-label="Git branch controls"
      >
        <button
          className={data.branchesCollapsed ? styles.reopen : styles.toggle}
          aria-label={
            data.branchesCollapsed ? 'Show Git Branches' : 'Hide Git Branches'
          }
          title={
            data.branchesCollapsed ? 'Show Git Branches' : 'Hide Git Branches'
          }
          aria-expanded={!data.branchesCollapsed}
          aria-controls="branch-content"
          onClick={() =>
            onIntent({
              kind: 'branches-collapsed',
              collapsed: !data.branchesCollapsed,
            })
          }
        >
          {data.branchesCollapsed ? (
            <>
              <span className={styles.railChevron} aria-hidden="true">
                <Icon name="chevron-right" />
              </span>
              <span className={styles.collapsedLabel} aria-hidden="true">
                Branches
              </span>
            </>
          ) : (
            <Icon name="chevron-left" />
          )}
        </button>
      </div>

      <label
        id="branch-search"
        className={styles.search}
        hidden={data.branchesCollapsed}
      >
        <span className={styles.searchField}>
          <span className={styles.searchIcon} aria-hidden="true">
            <Icon name="search" />
          </span>
          <span className={styles.srOnly}>Branch or tag</span>
          <input
            ref={search}
            id="reference-search"
            type="search"
            placeholder="Branch or tag"
            aria-label="Branch or tag"
            value={query}
            onChange={(event) => {
              memory.current.focusKey = '';
              memory.current.wantFocus = false;
              const value = event.target.value;

              setQueries((old) => ({ ...old, [id]: value }));
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                memory.current.focusKey = '';
                memory.current.wantFocus = false;
                event.preventDefault();
                setQueries((old) => ({ ...old, [id]: '' }));
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                const tree = document.getElementById('branches');
                const first = [
                  ...(tree?.querySelectorAll('vscode-tree-item') ?? []),
                ].find((item) => item.getClientRects().length > 0);

                if (first) {
                  first.active = true;
                  first.focus();
                }
              }
            }}
          />
        </span>
      </label>
      <div
        id="branch-actions"
        className={styles.actions}
        role="toolbar"
        aria-label="Branch actions"
        hidden={data.branchesCollapsed}
      >
        <div className={styles.commands} hidden={data.branchesCollapsed}>
          <ActionButton
            icon="target"
            className={styles.icon}
            label="Reveal Current Branch"
            tooltip="Reveal Current Branch (double-click to show history)"
            disabled={!currentRef}
            onClick={() => {
              if (!currentRef) return;
              setQueries((old) => ({ ...old, [id]: '' }));
              setExpansions((old) => {
                const next = new Map(old);
                const opened = new Map(old.get(id));

                for (const ancestor of currentBranchAncestors(branch))
                  opened.set(ancestor, true);
                next.set(id, opened);

                return next;
              });
              setReveal((old) => ({
                repositoryId: id,
                refId: currentRef.id,
                sequence: (old?.sequence ?? 0) + 1,
              }));
            }}
            onDoubleClick={() => {
              if (currentRef)
                onIntent({
                  kind: 'apply-scope',
                  scope: { kind: 'ref', refId: currentRef.id },
                });
            }}
          />
          <ActionButton
            icon={
              fetching
                ? 'loading codicon-modifier-spin'
                : fetchQueued
                  ? 'clock'
                  : 'cloud-download'
            }
            id="fetch"
            className={styles.icon}
            label="Fetch All Remotes"
            aria-busy={fetching}
            tooltip={
              fetching
                ? 'Fetching remotes…'
                : fetchQueued
                  ? 'Fetch is queued'
                  : 'Download remote commits without changing local branches.'
            }
            aria-description="Download remote commits without changing local branches."
            disabled={!data.repository || data.loading}
            onClick={() =>
              onIntent({
                kind: 'request',
                body: { kind: 'action', action: { kind: 'fetch-all' } },
              })
            }
          />
        </div>
      </div>

      <div
        id="branch-content"
        className={styles.browser}
        hidden={data.branchesCollapsed}
      >
        <BranchTree
          key={id}
          nodes={nodes}
          repositoryId={id}
          generation={data.generation}
          currentBranch={branch}
          operation={data.operation}
          referencesReady={data.referencesReady ?? true}
          selectedRefId={data.selectedRefId}
          selectedRefIds={selectedRefIds}
          scope={data.scope}
          expansion={expanded}
          memory={memory}
          reveal={reveal?.repositoryId === id ? reveal : null}
          onSelect={(refId, refIds) => {
            setSelection({ repositoryId: id, activeId: refId, refIds });
            onIntent({ kind: 'select-ref', refId });
          }}
          onApply={(scope) => onIntent({ kind: 'apply-scope', scope })}
          onExpansion={onExpansion}
        />
      </div>
    </aside>
  );
}
