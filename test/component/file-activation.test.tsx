import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { initialView } from '../../src/webview/app/model/state';
import { ChangedFiles } from '../../src/webview/pages/log/ui/details/ChangedFiles';
import { FileTree } from '../../src/webview/pages/log/ui/details/FileTree';

const file = {
  id: 'file',
  status: 'modified' as const,
  oldPath: 'a.ts',
  newPath: 'a.ts',
};

afterEach(() => vi.useRealTimers());

test('a pointer click requests its preview immediately', () => {
  vi.useFakeTimers();
  const onOpen = vi.fn();

  render(<FileTree files={[file]} selectedPath={null} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole('treeitem'), { detail: 1 });
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('file', true);
  vi.advanceTimersByTime(1000);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test('double-click promotes the preview; Enter opens a regular diff directly', () => {
  const onOpen = vi.fn();

  render(<FileTree files={[file]} selectedPath={null} onOpen={onOpen} />);
  const row = screen.getByRole('treeitem');

  fireEvent.click(row, { detail: 1 });
  fireEvent.click(row, { detail: 2 });
  fireEvent.doubleClick(row, { detail: 2 });
  expect(onOpen.mock.calls).toEqual([
    ['file', true],
    ['file', false],
  ]);
  onOpen.mockClear();
  fireEvent.keyDown(row, { key: 'Enter' });
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('file', false);
});

test('retained inactive files never open an editor', () => {
  const onIntent = vi.fn();
  const sha = 'a'.repeat(40);
  const data = {
    ...initialView(),
    selectedSha: sha,
    details: {
      sha,
      parents: [],
      message: 'Initial',
      authorName: null,
      authorEmail: null,
      authorDate: null,
      commitDate: null,
    },
    files: { root: [file] },
  };

  render(<ChangedFiles data={data} onIntent={onIntent} inactive />);
  const row = screen.getByRole('treeitem', { name: 'Modified · a.ts' });

  fireEvent.click(row, { detail: 1 });
  fireEvent.doubleClick(row, { detail: 2 });
  fireEvent.keyDown(row, { key: 'Enter' });
  expect(onIntent).not.toHaveBeenCalled();
});
