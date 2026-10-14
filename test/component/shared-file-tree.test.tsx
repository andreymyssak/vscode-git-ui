import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { FileTree as CommitFiles } from '../../src/webview/pages/log/ui/details/FileTree';
import { ChangeTree } from '../../src/webview/pages/source-control/ui/ChangeTree';

test('a range extends from the file selected by the host when the tree opens', () => {
  const files = ['a.ts', 'b.ts'].map((path) => ({
    id: path,
    newPath: path,
    oldPath: path,
    status: 'modified' as const,
  }));

  render(
    <CommitFiles
      files={files}
      selectedPath="a.ts"
      onOpen={vi.fn()}
      context={{
        repositoryId: 'fixture',
        generation: 1,
        commitSha: 'a'.repeat(40),
        canApply: true,
      }}
    />,
  );
  const second = screen.getByRole('treeitem', { name: 'Modified · b.ts' });

  fireEvent.click(second, { shiftKey: true });
  expect(screen.getAllByRole('treeitem', { selected: true })).toHaveLength(2);
  fireEvent.contextMenu(second);
  expect(
    JSON.parse(second.getAttribute('data-vscode-context') ?? '{}'),
  ).toMatchObject({
    fileIds: ['a.ts', 'b.ts'],
    fileSelectionCount: 2,
  });
});

test('a host-selected file replaces the existing range and native menu target', () => {
  const files = ['src/a.ts', 'src/b.ts', 'docs/c.ts'].map((path) => ({
    id: path,
    newPath: path,
    oldPath: path,
    status: 'modified' as const,
  }));
  const context = {
    repositoryId: 'fixture',
    generation: 1,
    commitSha: 'a'.repeat(40),
    canApply: true,
  };
  const onOpen = vi.fn();
  const view = render(
    <CommitFiles
      files={files}
      context={context}
      selectedPath={null}
      onOpen={onOpen}
    />,
  );
  const row = (name: string) =>
    screen.getByRole('treeitem', { name: `Modified · ${name}` });

  fireEvent.click(row('a.ts'));
  fireEvent.click(row('b.ts'), { shiftKey: true });
  expect(screen.getAllByRole('treeitem', { selected: true })).toHaveLength(2);
  view.rerender(
    <CommitFiles
      files={files}
      context={context}
      selectedPath="docs/c.ts"
      onOpen={onOpen}
    />,
  );
  expect(screen.getAllByRole('treeitem', { selected: true })).toEqual([
    row('c.ts'),
  ]);
  fireEvent.contextMenu(row('c.ts'));
  expect(
    JSON.parse(row('c.ts').getAttribute('data-vscode-context') ?? '{}'),
  ).toMatchObject({
    fileIds: ['docs/c.ts'],
    fileSelectionCount: 1,
  });
});

test('commit details and checked changes share row styling, compact folders and file activation', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const onCheck = vi.fn();
  const file = {
    path: 'src/nested/a.ts',
    originalPath: 'src/nested/a.ts',
    status: 'M',
  };

  render(
    <>
      <section aria-label="Commit details">
        <CommitFiles
          context={{
            repositoryId: 'fixture',
            generation: 1,
            commitSha: 'a'.repeat(40),
            canApply: false,
          }}
          files={[
            {
              id: 'file',
              newPath: file.path,
              oldPath: file.originalPath,
              status: 'modified',
            },
          ]}
          selectedPath={null}
          onOpen={onOpen}
        />
      </section>
      <section aria-label="Checked changes">
        <ChangeTree
          files={[file]}
          label="Changes"
          checked={new Set()}
          collapsed={[]}
          disabled={false}
          fileKey={(item) => item.path}
          folderKey={(path) => path}
          onCollapse={() => undefined}
          onCheck={onCheck}
          onOpen={(item) => onOpen(item.path)}
          context={() => '{}'}
          decoration={() => ({
            kind: 'modified',
            badge: 'M',
            description: 'Modified',
          })}
        />
      </section>
    </>,
  );
  const details = within(
    screen.getByRole('region', { name: 'Commit details' }),
  );
  const changes = within(
    screen.getByRole('region', { name: 'Checked changes' }),
  );
  const historical = details.getByRole('treeitem', { name: 'Modified · a.ts' });
  const working = changes.getByRole('treeitem', { name: file.path });

  expect(historical.className).toBe(working.className);
  expect(
    details.getByRole('treeitem', { name: 'src/nested 1 file' }),
  ).toHaveAttribute('aria-expanded', 'true');
  expect(changes.getByRole('treeitem', { name: 'src/nested' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  expect(details.queryByRole('checkbox')).toBeNull();
  await user.click(within(working).getByRole('checkbox'));
  expect(onCheck).toHaveBeenCalledExactlyOnceWith([file], true);
  expect(onOpen).not.toHaveBeenCalled();
  await user.click(working);
  expect(onOpen).toHaveBeenLastCalledWith(file.path);
  await user.click(historical);
  expect(onOpen).toHaveBeenLastCalledWith('file', true);
});

function selectableChanges() {
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'z.ts'].map((path) => ({
    path,
    originalPath: path,
    status: 'M',
  }));
  const onOpen = vi.fn();
  const onCheck = vi.fn();

  render(
    <ChangeTree
      files={files}
      label="Changes"
      root="Changes"
      groupByDirectory={false}
      checked={new Set()}
      collapsed={[]}
      disabled={false}
      fileKey={(file) => file.path}
      folderKey={(path) => path}
      onCollapse={() => undefined}
      onCheck={onCheck}
      onOpen={onOpen}
      context={(file, selected = [file]) =>
        JSON.stringify({
          path: file.path,
          paths: selected.map((item) => item.path),
        })
      }
      folderContext={(path, selected) =>
        JSON.stringify({ path, paths: selected.map((item) => item.path) })
      }
      decoration={() => ({
        kind: 'modified',
        badge: 'M',
        description: 'Modified',
      })}
    />,
  );

  return { files, onOpen, onCheck };
}

test('Shift and command clicks select ranges and individual rows without changing checkboxes or opening diffs', () => {
  const { onOpen, onCheck } = selectableChanges();
  const row = (name: string) => screen.getByRole('treeitem', { name });

  fireEvent.click(row('src/a.ts'));
  fireEvent.click(row('src/c.ts'), { shiftKey: true });
  expect(
    screen
      .getAllByRole('treeitem', { selected: true })
      .map((item) => item.getAttribute('aria-label')),
  ).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  fireEvent.click(row('z.ts'), { metaKey: true });
  fireEvent.click(row('src/b.ts'), { ctrlKey: true });
  expect(
    screen
      .getAllByRole('treeitem', { selected: true })
      .map((item) => item.getAttribute('aria-label')),
  ).toEqual(['src/a.ts', 'src/c.ts', 'z.ts']);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ path: 'src/a.ts' }),
    true,
  );
  expect(onCheck).not.toHaveBeenCalled();
});

test('right-click preserves a selected group, targets an outside row and gives the root all changed files', () => {
  const { onOpen } = selectableChanges();
  const first = screen.getByRole('treeitem', { name: 'src/a.ts' });
  const third = screen.getByRole('treeitem', { name: 'src/c.ts' });
  const outside = screen.getByRole('treeitem', { name: 'z.ts' });

  fireEvent.click(first);
  fireEvent.click(third, { shiftKey: true });
  fireEvent.contextMenu(first);
  expect(JSON.parse(first.dataset.vscodeContext ?? '{}')).toEqual({
    path: 'src/a.ts',
    paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  });
  fireEvent.contextMenu(outside);
  expect(JSON.parse(outside.dataset.vscodeContext ?? '{}')).toEqual({
    path: 'z.ts',
    paths: ['z.ts'],
  });
  const root = screen.getByRole('treeitem', { name: 'Changes' });

  fireEvent.contextMenu(root);
  expect(JSON.parse(root.dataset.vscodeContext ?? '{}')).toEqual({
    path: '',
    paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'z.ts'],
  });
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test('Shift keyboard navigation extends selection and keyboard context menus target the range', () => {
  selectableChanges();
  const first = screen.getByRole('treeitem', { name: 'src/a.ts' });
  const second = screen.getByRole('treeitem', { name: 'src/b.ts' });

  fireEvent.click(first);
  fireEvent.keyDown(first, { key: 'ArrowDown', shiftKey: true });
  expect(second).toHaveFocus();
  expect(first).toHaveAttribute('aria-selected', 'true');
  expect(second).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(second, { key: 'F10', shiftKey: true });
  expect(JSON.parse(second.dataset.vscodeContext ?? '{}').paths).toEqual([
    'src/a.ts',
    'src/b.ts',
  ]);
});

test('additive keyboard ranges retain earlier disjoint highlighted rows', () => {
  selectableChanges();
  const first = screen.getByRole('treeitem', { name: 'src/a.ts' });
  const last = screen.getByRole('treeitem', { name: 'z.ts' });

  fireEvent.click(first);
  fireEvent.click(last, { ctrlKey: true });
  fireEvent.keyDown(last, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
  expect(
    screen
      .getAllByRole('treeitem', { selected: true })
      .map((row) => row.getAttribute('aria-label')),
  ).toEqual(['src/a.ts', 'src/c.ts', 'z.ts']);
});

test('a replacement folder and deleted file have independent highlights and context targets', () => {
  const files = ['sample.txt', 'sample.txt/child.txt'].map((path) => ({
    path,
    originalPath: path,
    status: 'M',
  }));
  const { container } = render(
    <ChangeTree
      files={files}
      label="Changes"
      checked={new Set()}
      collapsed={[]}
      disabled={false}
      fileKey={(file) => file.path}
      folderKey={(path) => path}
      onCollapse={() => undefined}
      onCheck={() => undefined}
      onOpen={() => undefined}
      context={(file, selected = [file]) =>
        JSON.stringify({ paths: selected.map((item) => item.path) })
      }
      folderContext={(_, selected) =>
        JSON.stringify({ paths: selected.map((item) => item.path) })
      }
      decoration={() => ({
        kind: 'modified',
        badge: 'M',
        description: 'Modified',
      })}
    />,
  );
  const folder = container.querySelector(
    '[data-folder="sample.txt"] > summary',
  );
  const file = container.querySelector('[data-file="sample.txt"]');

  expect(folder).not.toBeNull();
  expect(file).not.toBeNull();
  if (!folder || !file) throw new Error('Missing replacement rows');
  fireEvent.contextMenu(folder);
  expect(
    JSON.parse(folder.getAttribute('data-vscode-context') ?? '{}').paths,
  ).toEqual(['sample.txt/child.txt']);
  expect(folder).toHaveAttribute('aria-selected', 'true');
  expect(file).toHaveAttribute('aria-selected', 'false');
  fireEvent.contextMenu(file);
  expect(
    JSON.parse(file.getAttribute('data-vscode-context') ?? '{}').paths,
  ).toEqual(['sample.txt']);
  expect(folder).toHaveAttribute('aria-selected', 'false');
  expect(file).toHaveAttribute('aria-selected', 'true');
});
