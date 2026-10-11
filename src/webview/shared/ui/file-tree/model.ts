export type FileTreeNode<T> =
  | { kind: 'file'; name: string; path: string; file: T }
  | {
      kind: 'folder';
      name: string;
      path: string;
      children: FileTreeNode<T>[];
      files: T[];
    };

export interface FileDecoration {
  badge: string;
  description: string;
  kind:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'untracked'
    | 'conflict'
    | 'unknown';
}

export type FolderDecoration = Pick<FileDecoration, 'kind' | 'description'>;

const folderPriority: Record<FileDecoration['kind'], number> = {
  conflict: 4,
  modified: 2,
  added: 1,
  renamed: 1,
  untracked: 1,
  deleted: 0,
  unknown: 0,
};

export function folderDecoration(
  decorations: readonly FileDecoration[],
): FolderDecoration | undefined {
  let selected: FileDecoration | undefined;

  for (const decoration of decorations) {
    const priority = folderPriority[decoration.kind];

    if (priority > (selected ? folderPriority[selected.kind] : 0))
      selected = decoration;
  }

  return selected
    ? { kind: selected.kind, description: 'Contains emphasized items' }
    : undefined;
}

const names = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export function buildFileTree<T>({
  files,
  pathOf,
  groupByDirectory = true,
}: {
  files: readonly T[];
  pathOf(this: void, file: T): string;
  groupByDirectory?: boolean;
}): FileTreeNode<T>[] {
  const roots: FileTreeNode<T>[] = [];
  const folders = new Map<
    string,
    Extract<FileTreeNode<T>, { kind: 'folder' }>
  >();

  for (const file of files) {
    const path = pathOf(file);
    const parts = path.split('/');
    let children = roots;
    let directory = '';

    for (const name of groupByDirectory ? parts.slice(0, -1) : []) {
      directory = directory ? `${directory}/${name}` : name;
      let folder = folders.get(directory);

      if (!folder) {
        folder = {
          kind: 'folder',
          name,
          path: directory,
          children: [],
          files: [],
        };
        folders.set(directory, folder);
        children.push(folder);
      }

      folder.files.push(file);
      children = folder.children;
    }

    children.push({ kind: 'file', name: parts.at(-1) ?? path, path, file });
  }

  const compactAndSort = (nodes: FileTreeNode<T>[]): FileTreeNode<T>[] =>
    nodes
      .map((node): FileTreeNode<T> => {
        if (node.kind === 'file') return node;
        let folder = node;

        while (
          folder.children.length === 1 &&
          folder.children[0]?.kind === 'folder'
        ) {
          const child = folder.children[0];

          folder = { ...child, name: `${folder.name}/${child.name}` };
        }

        return { ...folder, children: compactAndSort(folder.children) };
      })
      .sort((left, right) =>
        left.kind !== right.kind
          ? left.kind === 'folder'
            ? -1
            : 1
          : names.compare(left.name, right.name) ||
            left.name.localeCompare(right.name),
      );

  return compactAndSort(roots);
}

export const fileCountLabel = (count: number) =>
  `${count} ${count === 1 ? 'file' : 'files'}`;
