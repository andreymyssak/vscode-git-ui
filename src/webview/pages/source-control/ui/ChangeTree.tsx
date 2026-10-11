import type { ReactNode } from 'react';

import type {
  SourceControlRepository,
  SourceControlState,
} from '@contracts/source-control';
import { FileTree, type FolderDecoration } from '@webview/shared/ui';

import type { FileDecoration } from '../model/file-status';
import type { TreeFile } from '../model/file-tree';

interface Props<T extends TreeFile> {
  files: readonly T[];
  label: string;
  checked: ReadonlySet<string>;
  collapsed: readonly string[];
  disabled: boolean;
  fileKey(this: void, file: T): string;
  folderKey(this: void, path: string): string;
  onCollapse(this: void, key: string, collapsed: boolean): void;
  onCheck(this: void, files: T[], checked: boolean): void;
  onOpen(this: void, file: T): void;
  context(this: void, file: T, selected: T[]): string;
  folderContext?(this: void, path: string, selected: T[]): string;
  decoration(this: void, file: T): FileDecoration;
  folderDecoration?(
    this: void,
    files: readonly T[],
  ): FolderDecoration | undefined;
  snapshot?: string;
  root?: string;
  groupByDirectory?: boolean;
  reveal?: SourceControlState['reveal'];
  pathLabel?: SourceControlRepository['pathLabel'];
  hoverDelay?: number;
  actions?(this: void, file: T): ReactNode;
}

export function ChangeTree<T extends TreeFile>(props: Props<T>) {
  const pathLabel = (path: string) => {
    const label = props.pathLabel;

    if (!label) return path;
    const root = label.root.endsWith(label.separator)
      ? label.root
      : `${label.root}${label.separator}`;

    return `${root}${path.split('/').join(label.separator)}`;
  };

  return (
    <FileTree
      files={props.files}
      label={props.label}
      pathOf={(file) => file.path}
      fileKey={props.fileKey}
      decoration={props.decoration}
      context={props.context}
      multiSelect
      {...(props.folderContext ? { folderContext: props.folderContext } : {})}
      onOpen={props.onOpen}
      {...(props.folderDecoration
        ? { folderDecoration: props.folderDecoration }
        : {})}
      pathLabel={pathLabel}
      hoverDelay={props.hoverDelay ?? 500}
      {...(props.actions ? { actions: props.actions } : {})}
      selection={{
        checked: props.checked,
        disabled: props.disabled,
        onChange: props.onCheck,
      }}
      expansion={{
        isCollapsed: (path) => props.collapsed.includes(props.folderKey(path)),
        onChange: (path, collapsed) =>
          props.onCollapse(props.folderKey(path), collapsed),
      }}
      {...(props.snapshot !== undefined ? { snapshot: props.snapshot } : {})}
      {...(props.root !== undefined ? { root: props.root } : {})}
      groupByDirectory={props.groupByDirectory ?? true}
      reveal={props.reveal ?? null}
    />
  );
}
