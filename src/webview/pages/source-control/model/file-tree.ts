import { buildFileTree, type FileTreeNode } from '@webview/shared/ui';

export interface TreeFile {
  path: string;
  originalPath: string;
  status: string;
}

export type ChangeNode<T extends TreeFile> = FileTreeNode<T>;

export function buildChangeTree<T extends TreeFile>(
  files: readonly T[],
  groupByDirectory = true,
): ChangeNode<T>[] {
  return buildFileTree({
    files,
    pathOf: (file) => file.path,
    groupByDirectory,
  });
}
