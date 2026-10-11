import clsx from 'clsx';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useContext, useEffect, useRef, useState } from 'react';

import { dispatchContextMenu, offsetPointerContextMenu } from '../context-menu';
import { FileIcon } from '../file-icon/FileIcon';
import { FileIconThemeContext } from '../file-icon/FileIconTheme';
import { Icon } from '../icon/Icon';
import styles from './FileTree.module.css';
import { FileTreeCheckbox } from './FileTreeCheckbox';
import {
  buildFileTree,
  fileCountLabel,
  type FileDecoration,
  type FileTreeNode,
  type FolderDecoration,
} from './model';
import { PathHint } from './PathHint';
import { useRowSelection } from './use-row-selection';

interface Props<T> {
  files: readonly T[];
  label: string;
  pathOf(this: void, file: T): string;
  fileKey(this: void, file: T): string;
  decoration(this: void, file: T): FileDecoration;
  onOpen(this: void, file: T, preview: boolean): void;
  fileLabel?(this: void, file: T): string;
  fileTitle?(this: void, file: T): string;
  folderDecoration?(
    this: void,
    files: readonly T[],
  ): FolderDecoration | undefined;
  context?(this: void, file: T, selected: T[]): string;
  folderContext?(this: void, path: string, selected: T[]): string;
  multiSelect?: boolean;
  actions?(this: void, file: T): ReactNode;
  pathLabel?(this: void, path: string): string;
  hoverDelay?: number;
  selection?: {
    checked: ReadonlySet<string>;
    disabled: boolean;
    onChange(this: void, files: T[], checked: boolean): void;
  };
  expansion?: {
    isCollapsed(this: void, path: string): boolean;
    onChange(this: void, path: string, collapsed: boolean): void;
  };
  selectedPath?: string | null;
  revealSelected?: boolean;
  reveal?: { path: string; sequence: number } | null;
  snapshot?: string;
  root?: string;
  groupByDirectory?: boolean;
  depth?: number;
  role?: 'tree' | 'group';
}

export function navigateFileTree(event: KeyboardEvent<HTMLDivElement>) {
  if (
    ![
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
    ].includes(event.key) ||
    !(event.target instanceof HTMLElement)
  )
    return;
  const target = event.target.closest<HTMLElement>('[role="treeitem"]');
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ].filter((row) => {
    if (row.closest('[hidden]')) return false;
    let parent = row.parentElement;

    while (parent && parent !== event.currentTarget) {
      if (
        parent instanceof HTMLDetailsElement &&
        !parent.open &&
        parent.querySelector(':scope > summary') !== row
      )
        return false;
      parent = parent.parentElement;
    }

    return true;
  });
  const index = target ? rows.indexOf(target) : -1;

  if (!target || index < 0) return;
  event.preventDefault();
  const folder = target.closest('details');

  if (event.key === 'ArrowRight') {
    if (target.hasAttribute('aria-expanded') && folder) {
      if (!folder.open)
        (
          target.querySelector<HTMLElement>('[data-tree-disclosure]') ?? target
        ).click();
      else {
        const next = rows[index + 1];

        next?.focus();

        return next;
      }
    }

    return;
  }

  if (event.key === 'ArrowLeft') {
    if (target.hasAttribute('aria-expanded') && folder?.open)
      (
        target.querySelector<HTMLElement>('[data-tree-disclosure]') ?? target
      ).click();
    else {
      const parent = target.hasAttribute('aria-expanded')
        ? folder?.parentElement?.closest('details')
        : folder;

      const next = parent?.querySelector<HTMLElement>(
        ':scope > [role="treeitem"]',
      );

      next?.focus();

      return next;
    }

    return;
  }

  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : event.key === 'ArrowDown'
          ? Math.min(rows.length - 1, index + 1)
          : Math.max(0, index - 1);

  const row = rows[next];

  row?.focus();

  return row;
}

function fileIcon(path: string) {
  if (/\.(?:json|jsonc)$/i.test(path)) return 'json';
  if (/\.(?:ts|tsx|js|jsx|html|css|scss|py|go|rs|sh|ya?ml)$/i.test(path))
    return 'file-code';
  if (/\.(?:png|jpg|jpeg|gif|svg|webp|ico)$/i.test(path)) return 'file-media';
  if (/\.(?:zip|gz|tar|7z)$/i.test(path)) return 'file-zip';

  return 'file';
}

export function FileTree<T>(props: Props<T>) {
  const children = buildFileTree({
    files: props.files,
    pathOf: props.pathOf,
    groupByDirectory: props.groupByDirectory ?? true,
  });
  const nodes: FileTreeNode<T>[] = props.root
    ? [
        {
          kind: 'folder',
          name: props.root,
          path: '',
          children,
          files: [...props.files],
        },
      ]
    : children;
  const treeRef = useRef<HTMLDivElement>(null);
  const revealedSequence = useRef(0);
  const [active, setActive] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [previousPath, setPreviousPath] = useState(props.selectedPath);

  if (previousPath !== props.selectedPath) {
    setPreviousPath(props.selectedPath);
    if (props.selectedPath)
      setCollapsed(
        new Set(
          [...collapsed].filter(
            (path) => !props.selectedPath?.startsWith(`${path}/`),
          ),
        ),
      );
  }

  const isCollapsed = (path: string) =>
    props.expansion?.isCollapsed(path) ?? collapsed.has(path);
  const toggle = (path: string) => {
    const next = !isCollapsed(path);

    if (props.expansion) props.expansion.onChange(path, next);
    else
      setCollapsed((previous) => {
        const updated = new Set(previous);

        if (next) updated.add(path);
        else updated.delete(path);

        return updated;
      });
  };

  const rowKey = (node: FileTreeNode<T>) =>
    JSON.stringify(
      node.kind === 'folder'
        ? ['folder', node.path]
        : ['file', props.fileKey(node.file)],
    );
  const visible = new Map<string, FileTreeNode<T>>();
  const visit = (items: FileTreeNode<T>[]) => {
    for (const node of items) {
      visible.set(rowKey(node), node);
      if (node.kind === 'folder' && !isCollapsed(node.path))
        visit(node.children);
    }
  };

  visit(nodes);
  const rowSelection = useRowSelection([...visible.keys()]);
  const selectedFiles = (
    node: FileTreeNode<T>,
    selected = rowSelection.selected,
  ) => {
    const targets = selected.has(rowKey(node))
      ? [...visible.values()].filter((item) => selected.has(rowKey(item)))
      : [node];
    const keys = new Set(
      targets.flatMap((item) =>
        (item.kind === 'folder' ? item.files : [item.file]).map(props.fileKey),
      ),
    );

    return props.files.filter((file) => keys.has(props.fileKey(file)));
  };

  const contextFor = (
    node: FileTreeNode<T>,
    selected = rowSelection.selected,
  ) => {
    const files = selectedFiles(node, selected);

    return node.kind === 'file'
      ? props.context?.(node.file, files)
      : props.folderContext?.(node.path, files);
  };

  const prepareContext = (node: FileTreeNode<T>, target: HTMLElement) => {
    const selected =
      props.multiSelect && !rowSelection.selected.has(rowKey(node))
        ? rowSelection.select(rowKey(node))
        : rowSelection.selected;
    const context = contextFor(node, selected);

    // The workbench reads the DOM during this event, before React's batched render.
    if (context) target.dataset.vscodeContext = context;
    target.focus();
  };

  const current =
    active !== null && visible.has(active)
      ? active
      : nodes[0] && rowKey(nodes[0]);
  const theme = useContext(FileIconThemeContext);
  const associations = theme?.associations;
  const hasFiles =
    !associations ||
    !!associations.file ||
    [
      associations.fileNames,
      associations.fileExtensions,
      associations.languageIds,
    ].some((map) => Object.keys(map).length > 0);
  const hasFolders =
    !associations ||
    !!associations.folder ||
    !!associations.folderExpanded ||
    [associations.folderNames, associations.folderNamesExpanded].some(
      (map) => Object.keys(map).length > 0,
    );

  useEffect(() => {
    if (!props.revealSelected || !props.selectedPath) return;
    const row = [
      ...(treeRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? []),
    ].find((row) => row.dataset.path === props.selectedPath);

    row?.scrollIntoView?.({ block: 'nearest' });
  }, [props.files, props.selectedPath, props.revealSelected]);

  useEffect(() => {
    if (!props.reveal || revealedSequence.current === props.reveal.sequence)
      return;
    const row = [
      ...(treeRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? []),
    ].find((row) => row.dataset.path === props.reveal?.path);

    if (!row) return;
    revealedSequence.current = props.reveal.sequence;
    if (props.multiSelect && row.dataset.treeRowKey)
      rowSelection.select(row.dataset.treeRowKey);
    row.focus();
    row.scrollIntoView?.({ block: 'nearest' });
  }, [
    props.reveal,
    props.expansion,
    props.groupByDirectory,
    props.multiSelect,
    rowSelection,
  ]);

  const draw = (node: FileTreeNode<T>, depth: number): ReactNode => {
    const key = rowKey(node);
    const root = node.kind === 'folder' && node.path === '';
    const files = node.kind === 'folder' ? node.files : [node.file];
    const count = files.filter((file) =>
      props.selection?.checked.has(props.fileKey(file)),
    ).length;
    const checked = files.length > 0 && count === files.length;
    const mixed = count > 0 && !checked;
    const open = !isCollapsed(node.path);
    const decoration =
      node.kind === 'file' ? props.decoration(node.file) : null;
    const folderDecoration =
      node.kind === 'folder' && !root
        ? props.folderDecoration?.(node.files)
        : undefined;
    const pathLabel =
      node.kind === 'file'
        ? (props.fileTitle?.(node.file) ??
          props.pathLabel?.(node.path) ??
          node.path)
        : root
          ? node.name
          : (props.pathLabel?.(node.path) ?? node.path);
    const description =
      node.kind === 'file'
        ? decoration?.description
        : root
          ? undefined
          : folderDecoration?.description;
    const disabled = props.selection?.disabled ?? false;
    const check = () => {
      if (!disabled && files.length) props.selection?.onChange(files, !checked);
    };

    const activate = (preview: boolean) => {
      if (root && props.selection) check();
      else if (node.kind === 'folder') toggle(node.path);
      else if (!disabled) props.onOpen(node.file, preview);
    };

    const row = (
      <>
        <span
          className={styles.chevron}
          data-tree-disclosure={
            node.kind === 'folder' && files.length ? true : undefined
          }
          onClick={(event) => {
            if (node.kind !== 'folder') return;
            event.preventDefault();
            event.stopPropagation();
            toggle(node.path);
          }}
        >
          {node.kind === 'folder' && files.length > 0 && (
            <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          )}
        </span>
        {props.selection && files.length > 0 && (
          <FileTreeCheckbox
            label={root ? 'Include all changes' : `Include ${node.path}`}
            checked={checked}
            mixed={mixed}
            disabled={disabled || !files.length}
            tabIndex={-1}
            onChange={(checked) => props.selection?.onChange(files, checked)}
          />
        )}
        {!root && (
          <span className={styles.glyph}>
            <FileIcon
              path={node.path}
              kind={node.kind}
              expanded={node.kind === 'folder' && open}
              fallback={node.kind === 'folder' ? 'folder' : fileIcon(node.path)}
            />
          </span>
        )}
        <PathHint
          delay={props.hoverDelay ?? 500}
          text={description ? `${pathLabel} • ${description}` : pathLabel}
          overflowOnly={
            node.kind === 'folder' &&
            (root || (props.pathLabel?.(node.path) ?? node.path) === node.name)
          }
        >
          {node.kind === 'folder'
            ? node.name.split('/').map((part, index) => (
                <span key={index}>
                  {index > 0 && (
                    <span data-path-separator className={styles.separator}>
                      /
                    </span>
                  )}
                  {part}
                </span>
              ))
            : node.name}
        </PathHint>
        {node.kind === 'file' && props.actions && (
          <span
            className={styles.actions}
            onClick={(event) => {
              event.stopPropagation();
              event.currentTarget
                .closest<HTMLElement>('[role="treeitem"]')
                ?.focus();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {props.actions(node.file)}
          </span>
        )}
        <span
          className={node.kind === 'folder' ? styles.count : styles.status}
          aria-hidden="true"
        >
          {node.kind === 'folder'
            ? fileCountLabel(files.length)
            : decoration?.badge}
        </span>
        {folderDecoration && (
          <span
            className={clsx(styles.status, styles.folderStatus)}
            data-folder-status
            aria-hidden="true"
          >
            <Icon name="circle-filled" />
          </span>
        )}
      </>
    );
    const rowProps = {
      role: 'treeitem',
      tabIndex: current === key ? 0 : -1,
      className: clsx(
        styles.row,
        node.kind === 'file' && styles.leaf,
        root && styles.root,
      ),
      'aria-label':
        node.kind === 'file'
          ? (props.fileLabel?.(node.file) ?? node.path)
          : props.selection
            ? node.path || node.name
            : `${node.name} ${fileCountLabel(files.length)}`,
      'aria-selected': props.multiSelect
        ? rowSelection.selected.has(key)
        : node.kind === 'file' && props.selectedPath !== undefined
          ? props.selectedPath === node.path
          : active === key,
      'aria-description':
        decoration?.description ?? folderDecoration?.description,
      'aria-level': depth + 1,
      'aria-expanded':
        node.kind === 'folder' && files.length ? open : undefined,
      'aria-checked':
        props.selection && files.length
          ? mixed
            ? ('mixed' as const)
            : checked
          : undefined,
      'aria-disabled': props.selection ? disabled : undefined,
      'data-file': node.kind === 'file' ? props.fileKey(node.file) : undefined,
      'data-tree-path': node.path,
      'data-tree-row-key': key,
      'data-path': node.kind === 'file' ? node.path : undefined,
      'data-root': root ? true : undefined,
      'data-snapshot': node.kind === 'file' ? props.snapshot : undefined,
      'data-status': decoration?.kind ?? folderDecoration?.kind,
      'data-vscode-context': contextFor(node),
      style: { '--tree-depth': depth } satisfies CSSProperties,
      onFocus: () => setActive(key),
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        event.preventDefault();
        event.currentTarget.focus();
        if (props.multiSelect) {
          rowSelection.select(key, event);
          if (event.shiftKey || event.metaKey || event.ctrlKey) return;
        }

        if (event.detail < 2) activate(true);
      },
      onDoubleClick: () => {
        if (node.kind === 'file') activate(false);
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          if (event.key === ' ' && props.selection) check();
          else activate(false);
        } else if (
          contextFor(node) &&
          (event.key === 'ContextMenu' ||
            (event.shiftKey && event.key === 'F10'))
        ) {
          event.preventDefault();
          prepareContext(node, event.currentTarget);
          const bounds = event.currentTarget.getBoundingClientRect();

          dispatchContextMenu(event.currentTarget, bounds.x + 8, bounds.y + 8);
        }
      },
      onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
        if (!contextFor(node)) return;
        prepareContext(node, event.currentTarget);
        offsetPointerContextMenu(event.nativeEvent, event.currentTarget);
      },
    };

    return node.kind === 'folder' ? (
      <details
        key={key}
        data-folder={node.name}
        open={open}
        style={{ '--tree-depth': depth } satisfies CSSProperties}
      >
        <summary {...rowProps}>{row}</summary>
        <div role="group" className={styles.children} hidden={!open}>
          {node.children.map((child) => draw(child, depth + 1))}
        </div>
      </details>
    ) : (
      <div key={key} {...rowProps}>
        {row}
      </div>
    );
  };

  return (
    <div
      role={props.role ?? 'tree'}
      ref={treeRef}
      aria-label={props.label}
      aria-multiselectable={props.multiSelect || undefined}
      className={clsx(
        styles.tree,
        hasFiles && !hasFolders && styles.alignFileIcons,
        !!props.selection && styles.checkable,
      )}
      onKeyDown={
        props.role === 'group'
          ? undefined
          : (event) => {
              const next = navigateFileTree(event);
              const key = next?.dataset.treeRowKey;

              if (
                props.multiSelect &&
                key !== undefined &&
                (event.shiftKey || !(event.metaKey || event.ctrlKey))
              )
                rowSelection.select(key, event);
            }
      }
    >
      {nodes.map((node) => draw(node, props.depth ?? 0))}
    </div>
  );
}
