import { expect, test } from 'vitest';

import { buildFileTree } from '../../src/webview/shared/ui/file-tree/model';

test('file hierarchy preserves opaque IDs ordering and duplicate basenames', () => {
  const files = [
    {
      id: 'a',
      status: 'added' as const,
      newPath: 'long/folder/name.txt',
      oldPath: null,
    },
    {
      id: 'b',
      status: 'deleted' as const,
      oldPath: 'other/name.txt',
      newPath: null,
    },
    {
      id: 'c',
      status: 'renamed' as const,
      oldPath: 'old.txt',
      newPath: 'long/new.txt',
    },
  ];
  const tree = buildFileTree({
    files,
    pathOf: (file) => file.newPath ?? file.oldPath ?? 'File',
  });

  expect(tree[0]?.kind).toBe('folder');
  expect(tree[0]?.name).toBe('long');
  if (tree[0]?.kind !== 'folder') throw new Error('Missing folder');
  expect(tree[0].children[0]?.name).toBe('folder');
  expect(tree[0].children[1]?.path).toBe('long/new.txt');
  if (tree[0].children[1]?.kind !== 'file') throw new Error('Missing file');
  expect(tree[0].children[1].file).toBe(files[2]);
  expect(tree[1]?.name).toBe('other');
});
test('file hierarchy compacts single-child folders and sorts folders and files naturally', () => {
  const paths = [
    'root.txt',
    'z/one.ts',
    'a/only/deep/a10.ts',
    'a/only/deep/a2.ts',
    'a/only/deep/z.ts',
  ];
  const files = paths.map((path, index) => ({
    id: 'opaque-' + index,
    status: 'modified' as const,
    oldPath: path,
    newPath: path,
  }));
  const tree = buildFileTree({
    files,
    pathOf: (file) => file.newPath ?? file.oldPath ?? 'File',
  });

  expect(tree.map((node) => [node.kind, node.name])).toStrictEqual([
    ['folder', 'a/only/deep'],
    ['folder', 'z'],
    ['file', 'root.txt'],
  ]);
  const folder = tree[0]!;

  if (folder.kind !== 'folder' || !('files' in folder))
    throw new Error('Missing folder count');
  expect(folder.path).toBe('a/only/deep');
  expect(folder.files).toHaveLength(3);
  expect(folder.children.map((node) => node.name)).toStrictEqual([
    'a2.ts',
    'a10.ts',
    'z.ts',
  ]);
  const first = folder.children[0]!;

  if (first.kind !== 'file') throw new Error('Missing changed file');
  expect(first.file).toBe(files[3]);
  expect(first.file.id).toBe('opaque-3');
});

test('flat grouping retains full paths and duplicate filenames while sorting naturally', () => {
  const files = ['src/file10.ts', 'other/file2.ts', 'src/file2.ts'].map(
    (path) => ({ path }),
  );
  const tree = buildFileTree({
    files,
    pathOf: (file) => file.path,
    groupByDirectory: false,
  });

  expect(tree.map((node) => node.name)).toEqual([
    'file2.ts',
    'file2.ts',
    'file10.ts',
  ]);
  expect(tree.map((node) => node.path)).toEqual([
    'other/file2.ts',
    'src/file2.ts',
    'src/file10.ts',
  ]);
  for (const node of tree) {
    expect(node.kind).toBe('file');
    if (node.kind === 'file') expect(files).toContain(node.file);
  }
});
