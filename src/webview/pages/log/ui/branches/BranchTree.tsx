import '@vscode-elements/elements/dist/vscode-tree/index.js';
import '@vscode-elements/elements/dist/vscode-tree-item/index.js';

import type { VscodeTree } from '@vscode-elements/elements/dist/vscode-tree/vscode-tree.js';
import { VscodeTreeItem } from '@vscode-elements/elements/dist/vscode-tree-item/vscode-tree-item.js';
import type { MutableRefObject } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { MAX_BRANCH_SELECTION } from '@contracts/branch-selection';
import type { Scope } from '@contracts/model';
import { isRecord } from '@contracts/validation';
import {
  dispatchContextMenu,
  Icon,
  offsetPointerContextMenu,
} from '@webview/shared/ui';

import type { BranchNode } from '../../model/branch-tree-state';
import styles from './BranchesPane.module.css';
import { BranchTracking } from './BranchTracking';

export interface TreeMemory {
  focusKey: string;
  wantFocus: boolean;
  scrollTop: number;
  scrollLeft: number;
  scrollEpoch: number;
}

interface Props {
  nodes: readonly BranchNode[];
  repositoryId: string;
  generation: number;
  currentBranch: string | null;
  selectedRefId: string | null;
  selectedRefIds: readonly string[];
  scope: Scope;
  expansion: ReadonlyMap<string, boolean>;
  memory: MutableRefObject<TreeMemory>;
  reveal?: { refId: string; sequence: number } | null;
  onSelect(this: void, refId: string | null, refIds: string[]): void;
  onApply(this: void, scope: Scope): void;
  onExpansion(this: void, id: string, open: boolean): void;
}

export function BranchTree({
  nodes,
  repositoryId,
  generation,
  currentBranch,
  selectedRefId,
  selectedRefIds,
  scope,
  expansion,
  memory,
  reveal,
  onSelect,
  onApply,
  onExpansion,
}: Props) {
  // VSCode Elements updates its native tree asynchronously through mutable cells.
  'use no memo';
  const root = useRef<VscodeTree>(null);
  const [selectedNode, setSelectedNode] = useState('');
  const pointerRef = useRef<string | null>(null);
  const revealed = useRef<number | null>(null);
  const scopeNode = scope.kind === 'all' ? 'scope:all' : '';
  const items = () => [
    ...(root.current?.querySelectorAll('vscode-tree-item') ?? []),
  ];
  const current = selectedRefId
    ? 'ref:' + selectedRefId
    : selectedNode.startsWith('ref:')
      ? scopeNode
      : selectedNode || scopeNode;
  const latest = useRef({ onSelect, onExpansion, current, selectedRefIds });

  useLayoutEffect(() => {
    latest.current = { onSelect, onExpansion, current, selectedRefIds };
  }, [onSelect, onExpansion, current, selectedRefIds]);
  useLayoutEffect(() => {
    const tree = root.current;

    if (!tree) return;
    const select = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const payload: unknown = event.detail;
      const selected: unknown = Array.isArray(payload)
        ? payload
        : isRecord(payload)
          ? payload.selectedItems
          : null;

      if (
        !Array.isArray(selected) ||
        !selected.every(
          (item: unknown): item is VscodeTreeItem =>
            item instanceof VscodeTreeItem,
        )
      )
        return;
      const ids = items()
        .filter(
          (item) =>
            selected.includes(item) &&
            item.dataset.ref &&
            item.getClientRects().length > 0,
        )
        .map((item) => item.dataset.ref!);
      const candidate =
        pointerRef.current ??
        items().find((item) => item.active)?.dataset.ref ??
        null;
      const activeId = ids.includes(candidate ?? '')
        ? candidate
        : (ids.at(-1) ?? null);

      pointerRef.current = null;
      setSelectedNode(
        activeId ? 'ref:' + activeId : (selected[0]?.dataset.treeNode ?? ''),
      );
      latest.current.onSelect(activeId, ids);
    };

    // The tree emits selection before it updates reflected folder expansion.
    const expansion = new MutationObserver((changes) => {
      for (const change of changes) {
        const item = change.target;

        if (item instanceof VscodeTreeItem && item.dataset.folder)
          latest.current.onExpansion(item.dataset.treeNode!, item.open);
      }
    });

    tree.addEventListener('vsc-tree-select', select);
    expansion.observe(tree, {
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });

    return () => {
      tree.removeEventListener('vsc-tree-select', select);
      expansion.disconnect();
    };
  }, []);
  useLayoutEffect(() => {
    const tree = root.current;

    if (!tree) return;
    const epoch = memory.current.scrollEpoch;
    const scrollTop = tree.scrollTop;
    const scrollLeft = tree.scrollLeft;
    let cancelled = false;
    let frame: number | null = null;
    let finish: (() => void) | null = null;
    const restore = async () => {
      await tree.updateComplete;
      await Promise.all(items().map((item) => item.updateComplete));
      if (cancelled || !tree.isConnected) return;
      await new Promise<void>((resolve) => {
        finish = resolve;
        frame = requestAnimationFrame(() => {
          frame = null;
          finish = null;
          resolve();
        });
      });
      if (cancelled || !tree.isConnected) return;
      for (const item of items())
        item.selected = item.dataset.ref
          ? latest.current.selectedRefIds.includes(item.dataset.ref)
          : !latest.current.selectedRefIds.length &&
            item.dataset.treeNode === latest.current.current;
      const list = items();
      const focused = list.find(
        (item) => item.dataset.treeNode === memory.current.focusKey,
      );
      const active =
        focused ??
        (memory.current.focusKey
          ? undefined
          : list.find((item) => item.dataset.current)) ??
        list[0];

      if (active) {
        active.active = true;
        if (
          memory.current.wantFocus &&
          document.activeElement === document.body
        )
          active.focus({ preventScroll: true });
      }

      if (epoch === memory.current.scrollEpoch) {
        // A newer scroll can precede its event; do not restore over the live offset.
        if (tree.scrollTop === scrollTop)
          tree.scrollTop = memory.current.scrollTop;
        else memory.current.scrollTop = tree.scrollTop;
        if (tree.scrollLeft === scrollLeft)
          tree.scrollLeft = memory.current.scrollLeft;
        else memory.current.scrollLeft = tree.scrollLeft;
      }

      if (reveal && revealed.current !== reveal.sequence) {
        const target = list.find((item) => item.dataset.ref === reveal.refId);

        if (target && target.getClientRects().length > 0) {
          const row = target.getBoundingClientRect();
          const bounds = tree.getBoundingClientRect();

          tree.scrollTop +=
            row.top - bounds.top - (bounds.height - row.height) / 2;
          memory.current.scrollTop = tree.scrollTop;
          memory.current.scrollEpoch++;
          revealed.current = reveal.sequence;
        }
      }
    };

    void restore();

    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      finish?.();
    };
  }, [nodes, expansion, memory, current, selectedRefIds, reveal]);
  const draw = (node: BranchNode): React.ReactElement => {
    const ref = node.reference;
    const contextIds =
      ref && selectedRefIds.includes(ref.id)
        ? [...selectedRefIds]
        : ref
          ? [ref.id]
          : [];
    const canDelete =
      contextIds.length >= 2 &&
      contextIds.length <= MAX_BRANCH_SELECTION &&
      contextIds.every(
        (id) =>
          id.startsWith('refs/heads/') && id !== `refs/heads/${currentBranch}`,
      );
    const selected = ref
      ? selectedRefIds.includes(ref.id)
      : !selectedRefIds.length && node.id === current;
    const context = ref
      ? {
          webviewSection: 'branch',
          preventDefaultContextMenuItems: true,
          repositoryId: repositoryId,
          generation: generation,
          refId: ref.id,
          refKind: ref.kind,
          refCurrent: node.current,
          refSelectionCount: contextIds.length,
          refIds: contextIds,
          refsCanDelete: canDelete,
          refCanIntegrate:
            contextIds.length === 1 &&
            !!currentBranch &&
            ref.kind !== 'tag' &&
            !node.current,
          refCanUpdate:
            contextIds.length === 1 &&
            ref.kind === 'local' &&
            !!ref.tracking &&
            ref.tracking.behind !== null,
        }
      : undefined;
    const activate = () => {
      if (!node.scope) return;
      setSelectedNode(node.id);
      onSelect(ref?.id ?? null, ref ? [ref.id] : []);
      onApply(node.scope);
    };

    return (
      <vscode-tree-item
        key={node.id}
        data-tree-node={node.id}
        data-folder={!ref && !node.scope ? node.name : undefined}
        data-ref={ref?.id}
        data-current={node.current ? 'true' : undefined}
        data-scope={!ref ? node.scope?.kind : undefined}
        data-vscode-context={context ? JSON.stringify(context) : undefined}
        aria-label={node.name + (node.current ? ' (Current branch)' : '')}
        aria-selected={selected}
        title={ref?.name ?? node.name}
        selected={selected}
        open={expansion.get(node.id) ?? false}
        style={
          {
            '--reference-row-min-width': `${105 + node.depth * 8}px`,
            '--reference-depth': node.depth,
          } satisfies React.CSSProperties
        }
        onDoubleClick={(event) => {
          if (node.scope) {
            event.stopPropagation();
            activate();
          }
        }}
        onKeyDownCapture={(event) => {
          if (event.key === 'Enter' && node.scope) {
            event.preventDefault();
            event.stopPropagation();
            activate();
          }
        }}
        onContextMenu={(event) => {
          if (ref) {
            if (
              offsetPointerContextMenu(event.nativeEvent, event.currentTarget)
            )
              return;
            flushSync(() => {
              setSelectedNode(node.id);
              onSelect(
                ref.id,
                selectedRefIds.includes(ref.id)
                  ? [...selectedRefIds]
                  : [ref.id],
              );
            });
            event.currentTarget.active = true;
            event.currentTarget.focus({ preventScroll: true });
          }
        }}
      >
        {ref ? (
          <span
            slot="icon-leaf"
            className={node.current ? styles.currentGlyph : styles.glyph}
          >
            <Icon name={ref.kind === 'tag' ? 'tag' : 'git-branch'} />
          </span>
        ) : node.id.startsWith('folder:') ? (
          <>
            <span slot="icon-branch" className={styles.glyph}>
              <Icon name="folder" />
            </span>
            <span slot="icon-branch-opened" className={styles.glyph}>
              <Icon name="folder-opened" />
            </span>
          </>
        ) : null}
        <span data-reference-name="" className={styles.name}>
          {node.name}
        </span>
        {ref?.tracking && (ref.tracking.behind || ref.tracking.ahead) ? (
          <BranchTracking tracking={ref.tracking} />
        ) : null}
        {node.children.map(draw)}
      </vscode-tree-item>
    );
  };

  return (
    <vscode-tree
      ref={root}
      id="branches"
      className={styles.tree}
      aria-label="References"
      tabIndex={0}
      indent={8}
      indentGuides="always"
      multiSelect
      onClickCapture={(event) => {
        pointerRef.current =
          (event.target instanceof Element
            ? event.target.closest<VscodeTreeItem>('vscode-tree-item')?.dataset
                .ref
            : null) ?? null;
      }}
      data-vscode-context={JSON.stringify({
        webviewSection: 'references',
        preventDefaultContextMenuItems: true,
      })}
      onFocus={(event) => {
        const tree = event.currentTarget;

        if (event.target === tree) {
          const active =
            items().find(
              (item) => item.active && item.getClientRects().length > 0,
            ) ?? items()[0];

          active?.focus();
        } else {
          tree.tabIndex = -1;
          const item =
            event.target instanceof Element
              ? event.target.closest<VscodeTreeItem>('vscode-tree-item')
              : null;

          if (item) {
            memory.current.focusKey = item.dataset.treeNode ?? '';
            memory.current.wantFocus = true;
            item
              .querySelector('[data-reference-name]')
              ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            // Scroll events arrive later; pending restoration must see this intent.
            memory.current.scrollTop = tree.scrollTop;
            memory.current.scrollLeft = tree.scrollLeft;
            memory.current.scrollEpoch++;
          }
        }
      }}
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          event.currentTarget.tabIndex = 0;
          memory.current.wantFocus = false;
        }
      }}
      onScroll={(event) => {
        memory.current.scrollTop = event.currentTarget.scrollTop;
        memory.current.scrollLeft = event.currentTarget.scrollLeft;
        memory.current.scrollEpoch++;
      }}
      onKeyDownCapture={(event) => {
        pointerRef.current = null;
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const visible = items().filter(
            (item) => item.getClientRects().length > 0,
          );
          const target = event.key === 'Home' ? visible[0] : visible.at(-1);

          if (target) {
            target.active = true;
            target.focus();
          }
        }

        if (
          event.key === 'ContextMenu' ||
          (event.shiftKey && event.key === 'F10')
        ) {
          const target =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>('[data-ref]')
              : null;

          if (target) {
            event.preventDefault();
            const bounds = target.getBoundingClientRect();

            dispatchContextMenu(target, bounds.left + 20, bounds.top + 11);
          }
        }
      }}
    >
      {nodes.map(draw)}
      {!nodes.length && (
        <p className={styles.empty}>No matching branches or tags.</p>
      )}
    </vscode-tree>
  );
}
