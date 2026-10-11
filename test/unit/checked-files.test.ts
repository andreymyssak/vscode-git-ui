import { expect, test } from 'vitest';

import { CheckedFiles } from '../../src/extension/changes/checked-files';

type File = { path: string; originalPath: string | null };

const files = [
  { path: 'one/same.txt', originalPath: null },
  { path: 'one/nested/file.txt', originalPath: null },
  { path: 'two/same.txt', originalPath: 'old.txt' },
] as const;

test('only known checked paths are included', () => {
  const checked = new CheckedFiles<File>();

  checked.refresh(files);
  expect(checked.selected()).toEqual([]);
  checked.setFile('one/same.txt', true);
  checked.setFile('one/nested/file.txt', true);
  checked.setFile('missing.txt', true);
  expect(checked.selected()).toEqual(files.slice(0, 2));
  checked.setFile('one/same.txt', false);
  expect(checked.selected()).toEqual([files[1]]);
});

test('refresh preserves surviving checks, drops missing checks and starts new paths unchecked', () => {
  const checked = new CheckedFiles<File>();

  checked.refresh(files);
  for (const file of files) checked.setFile(file.path, true);
  checked.refresh([files[0], { path: 'new.txt', originalPath: null }]);
  expect(checked.selected()).toEqual([files[0]]);
});

test('clearing saved paths preserves other checked files', () => {
  const checked = new CheckedFiles<File>();

  checked.refresh(files);
  checked.setFile('two/same.txt', true);
  const captured = checked.selected();

  checked.setFile('one/same.txt', true);
  checked.clear(captured.map((file) => file.path));
  expect(checked.selected()).toEqual([files[0]]);
});
