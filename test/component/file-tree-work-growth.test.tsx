import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';

import { FileTree } from '../../src/webview/shared/ui/file-tree/FileTree';

function renderWork(size: number) {
  let keys = 0;
  let contexts = 0;

  renderToString(
    <FileTree
      files={Array.from({ length: size }, (_, index) => ({
        id: String(index),
        path: `src/file-${index}.ts`,
      }))}
      label="Work growth"
      pathOf={(file) => file.path}
      fileKey={(file) => {
        keys++;

        return file.id;
      }}
      decoration={() => ({
        kind: 'modified',
        badge: 'M',
        description: 'Modified',
      })}
      context={() => {
        contexts++;

        return '{}';
      }}
      multiSelect
      onOpen={() => undefined}
    />,
  );

  return { keys, contexts };
}

test('file tree preparation grows linearly and prepares native menus only on demand', () => {
  const small = renderWork(1000);
  const large = renderWork(5000);

  expect(large.keys).toBeLessThanOrEqual(small.keys * 6);
  expect(large.contexts).toBe(0);
});

test('collapsed descendants are unmounted while selected identities survive collapse', async () => {
  const { fireEvent, render, screen } = await import('@testing-library/react');
  const files = [
    { id: 'one', path: 'src/same.ts' },
    { id: 'two', path: 'src/same.ts' },
    { id: 'last', path: 'z.ts' },
  ];
  const view = render(
    <FileTree
      files={files}
      label="Files"
      pathOf={(file) => file.path}
      fileKey={(file) => file.id}
      decoration={() => ({
        kind: 'modified',
        badge: 'M',
        description: 'Modified',
      })}
      onOpen={() => undefined}
      multiSelect
      context={(_file, selected) =>
        JSON.stringify(selected.map((file) => file.id))
      }
    />,
  );
  const first = view.container.querySelector<HTMLElement>('[data-file="one"]')!;
  const second =
    view.container.querySelector<HTMLElement>('[data-file="two"]')!;

  fireEvent.click(first);
  fireEvent.click(second, { metaKey: true });
  const folder = screen.getByRole('treeitem', { name: 'src 2 files' });

  fireEvent.click(folder.querySelector('[data-tree-disclosure]')!);
  expect(view.container.querySelector('[data-file="one"]')).toBeNull();
  const last = screen.getByRole('treeitem', { name: 'z.ts' });

  fireEvent.click(last, { metaKey: true });
  fireEvent.contextMenu(last);
  expect(JSON.parse(last.dataset.vscodeContext ?? 'null')).toEqual([
    'one',
    'two',
    'last',
  ]);
  fireEvent.click(folder.querySelector('[data-tree-disclosure]')!);
  expect(view.container.querySelector('[data-file="two"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
