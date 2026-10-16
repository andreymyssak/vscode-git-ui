import clsx from 'clsx';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';

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
import { navigateFileTree } from './navigation';
import { PathHint } from './PathHint';
import { useRowSelection } from './use-row-selection';
import { useTreeViewport } from './use-tree-viewport';

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

export { navigateFileTree } from './navigation';

function fileIcon(path: string) {
  if (/\.(?:json|jsonc)$/i.test(path)) return 'json';
  if (/\.(?:ts|tsx|js|jsx|html|css|scss|py|go|rs|sh|ya?ml)$/i.test(path))
    return 'file-code';
  if (/\.(?:png|jpg|jpeg|gif|svg|webp|ico)$/i.test(path)) return 'file-media';
  if (/\.(?:zip|gz|tar|7z)$/i.test(path)) return 'file-zip';

  return 'file';
}

export function FileTree<T>(props: Props<T>) {
  const children = useMemo(
    () =>
      buildFileTree({
        files: props.files,
        pathOf: props.pathOf,
        groupByDirectory: props.groupByDirectory ?? true,
      }),
    [props.files, props.pathOf, props.groupByDirectory],
  );
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
  const revealed = useRef<{
    path: string;
    sequence: number | undefined;
    files: readonly T[];
  } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const requestedPath = props.reveal?.path ?? props.selectedPath;
  const [previousPath, setPreviousPath] = useState(requestedPath);

  if (previousPath !== requestedPath) {
    setPreviousPath(requestedPath);
    if (requestedPath)
      setCollapsed(
        new Set(
          [...collapsed].filter(
            (path) => path !== '' && !requestedPath.startsWith(`${path}/`),
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

  const { files: inputFiles, fileKey } = props;
  const fileKeys = useMemo(
    () => new Map(inputFiles.map((file) => [file, fileKey(file)])),
    [inputFiles, fileKey],
  );
  const rowKey = (node: FileTreeNode<T>) =>
    JSON.stringify(
      node.kind === 'folder'
        ? ['folder', node.path]
        : ['file', fileKeys.get(node.file)],
    );
  const parents = new Map<string, string | null>();
  const guides = new Map<
    string,
    { path: string; depth: number; start: number; end: number }
  >();
  const all = new Map<string, FileTreeNode<T>>();
  const rows: {
    key: string;
    node: FileTreeNode<T>;
    depth: number;
    parent: string | null;
    ancestors: string[];
    position: number;
    size: number;
  }[] = [];
  const visit = (
    items: FileTreeNode<T>[],
    depth: number,
    ancestors: string[],
    shown: boolean,
  ) => {
    items.forEach((node, index) => {
      const key = rowKey(node);

      all.set(key, node);
      parents.set(key, ancestors.at(-1) ?? null);
      if (shown)
        rows.push({
          key,
          node,
          depth,
          parent: ancestors.at(-1) ?? null,
          ancestors,
          position: index + 1,
          size: items.length,
        });
      if (node.kind === 'folder') {
        const start = rows.length;

        visit(
          node.children,
          depth + 1,
          [...ancestors, key],
          shown && !isCollapsed(node.path),
        );
        if (shown && rows.length > start)
          guides.set(key, { path: node.path, depth, start, end: rows.length });
      }
    });
  };

  visit(nodes, props.depth ?? 0, [], true);
  const visible = new Map(rows.map((row, index) => [row.key, index]));
  const externalFile = props.multiSelect
    ? props.files.find((file) => props.pathOf(file) === props.selectedPath)
    : undefined;
  const rowSelection = useRowSelection(
    [...visible.keys()],
    externalFile ? JSON.stringify(['file', props.fileKey(externalFile)]) : null,
  );

  const selectedFiles = (
    node: FileTreeNode<T>,
    selected = rowSelection.selected,
  ) => {
    if (!selected.has(rowKey(node)))
      return node.kind === 'folder' ? node.files : [node.file];
    const targets = [...selected].flatMap((key) => {
      const item = all.get(key);

      return item ? [item] : [];
    });
    const keys = new Set(
      targets.flatMap((item) =>
        (item.kind === 'folder' ? item.files : [item.file]).map((file) =>
          fileKeys.get(file),
        ),
      ),
    );

    return props.files.filter((file) => keys.has(fileKeys.get(file)));
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
  const viewport = useTreeViewport(
    treeRef,
    rows.map((row) => row.key),
    current || undefined,
  );
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
    const path =
      props.reveal?.path ?? (props.revealSelected ? props.selectedPath : null);
    const sequence = props.reveal?.sequence;

    if (
      !path ||
      !viewport.ready ||
      (revealed.current?.path === path &&
        revealed.current.sequence === sequence &&
        (!!props.reveal || revealed.current.files === props.files))
    )
      return;
    const index = rows.findIndex(
      (row) => row.node.kind === 'file' && row.node.path === path,
    );

    if (index < 0) return;
    revealed.current = { path, sequence, files: props.files };
    const key = rows[index]?.key;

    if (props.reveal && props.multiSelect && key) rowSelection.select(key);
    viewport.reveal(index, !!props.reveal);
  });

  const selectedGuides = new Set(
    [...rowSelection.selected].map((key) => parents.get(key)),
  );
  const focusedNode = active ? all.get(active) : undefined;
  const focusedGuide =
    focusedNode?.kind === 'folder' && !isCollapsed(focusedNode.path)
      ? active
      : active
        ? parents.get(active)
        : null;
  const mountedGuides = new Set(
    viewport.items.flatMap((item) => rows[item.index]?.ancestors ?? []),
  );

  const draw = (entry: (typeof rows)[number], start: number): ReactNode => {
    const { node, depth } = entry;
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
            event.currentTarget
              .closest<HTMLElement>('[role="treeitem"]')
              ?.focus();
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
      'aria-posinset': entry.position,
      'aria-setsize': entry.size,
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
      'data-folder': node.kind === 'folder' ? node.name : undefined,
      'data-tree-row-key': key,
      'data-path': node.kind === 'file' ? node.path : undefined,
      'data-root': root ? true : undefined,
      'data-snapshot': node.kind === 'file' ? props.snapshot : undefined,
      'data-status': decoration?.kind ?? folderDecoration?.kind,
      style: {
        '--tree-depth': depth,
        ...(viewport.natural
          ? {}
          : { position: 'absolute', top: start - viewport.margin }),
      } satisfies CSSProperties,
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
          (node.kind === 'file' ? props.context : props.folderContext) &&
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
        if (!(node.kind === 'file' ? props.context : props.folderContext))
          return;
        prepareContext(node, event.currentTarget);
        offsetPointerContextMenu(event.nativeEvent, event.currentTarget);
      },
    };

    return (
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
      aria-multiselectable={
        props.role !== 'group' ? props.multiSelect || undefined : undefined
      }
      className={clsx(
        styles.tree,
        hasFiles && !hasFolders && styles.alignFileIcons,
        !!props.selection && styles.checkable,
      )}
      style={{ position: 'relative', height: viewport.height }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || !(event.target instanceof HTMLElement))
          return;
        const target = event.target.closest<HTMLElement>('[data-tree-row-key]');
        const index = target?.dataset.treeRowKey
          ? visible.get(target.dataset.treeRowKey)
          : undefined;
        const entry = index === undefined ? undefined : rows[index];

        if (index === undefined || !entry) return;
        if (
          props.role === 'group' &&
          (event.key === 'Home' || event.key === 'End')
        ) {
          const outer =
            event.currentTarget.parentElement?.closest<HTMLElement>(
              '[role="tree"]',
            );

          if (outer) {
            const next = navigateFileTree(event, outer, (row) => {
              const key = row.dataset.treeRowKey;
              const index = key ? visible.get(key) : undefined;

              if (index === undefined) row.focus();
              else viewport.reveal(index, true);
            });
            const key = next?.dataset.treeRowKey;

            if (
              props.multiSelect &&
              key &&
              visible.has(key) &&
              (event.shiftKey || !(event.metaKey || event.ctrlKey))
            )
              rowSelection.select(key, event);
            if (event.defaultPrevented) event.stopPropagation();

            return;
          }
        }

        let next = index;

        if (event.key === 'ArrowRight') {
          if (entry.node.kind !== 'folder') return;
          if (isCollapsed(entry.node.path)) toggle(entry.node.path);
          else next = Math.min(index + 1, rows.length - 1);
        } else if (event.key === 'ArrowLeft') {
          if (entry.node.kind === 'folder' && !isCollapsed(entry.node.path))
            toggle(entry.node.path);
          else if (entry.parent) next = visible.get(entry.parent) ?? index;
          else return;
        } else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = rows.length - 1;
        else if (event.key === 'ArrowDown') {
          if (index === rows.length - 1 && props.role === 'group') return;
          next = Math.min(index + 1, rows.length - 1);
        } else if (event.key === 'ArrowUp') {
          if (index === 0 && props.role === 'group') return;
          next = Math.max(0, index - 1);
        } else return;
        event.preventDefault();
        event.stopPropagation();
        const key = rows[next]?.key;

        if (key) {
          setActive(key);
          if (
            props.multiSelect &&
            next !== index &&
            (event.shiftKey || !(event.metaKey || event.ctrlKey))
          )
            rowSelection.select(key, event);
          viewport.reveal(next, true);
        }
      }}
    >
      {viewport.items.map((item) => {
        const entry = rows[item.index];

        return entry ? draw(entry, item.start) : null;
      })}
      {[...mountedGuides].map((key) => {
        const guide = guides.get(key);

        return guide ? (
          <div
            key={key}
            aria-hidden="true"
            data-tree-guide={guide.path}
            data-selected={selectedGuides.has(key)}
            data-focused={focusedGuide === key}
            className={styles.guide}
            style={
              {
                '--tree-depth': guide.depth,
                top: guide.start * 22,
                height: (guide.end - guide.start) * 22,
              } satisfies CSSProperties
            }
          />
        ) : null;
      })}
    </div>
  );
}
