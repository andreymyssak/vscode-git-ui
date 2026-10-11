import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, onTestFinished, test } from 'vitest';

import type { FileIconTheme } from '../../src/shared/file-icons';
import type { FileChange } from '../../src/shared/model';
import { FileTree } from '../../src/webview/pages/log/ui/details/FileTree';
import { createBrowserBridge } from '../../src/webview/shared/api/vscode-bridge';
import { FileIconThemeProvider } from '../../src/webview/shared/ui/file-icon/FileIconTheme';

const theme: FileIconTheme = {
  definitions: {
    typescript: { uri: 'https://webview.test/typescript.svg' },
    folder: { uri: 'https://webview.test/folder.svg' },
  },
  associations: {
    fileExtensions: { ts: 'typescript' },
    fileNames: {},
    languageIds: {},
    folderNames: {},
    folderNamesExpanded: {},
    folder: 'folder',
  },
  languages: { fileNames: {}, extensions: {} },
};
const files = [
  {
    id: 'file',
    status: 'modified',
    oldPath: 'src/file.ts',
    newPath: 'src/file.ts',
  },
] satisfies FileChange[];

test('active icon changes update images while preserving the selected file and collapsed folder', async () => {
  const target = new EventTarget();
  const bridge = createBrowserBridge(
    { postMessage() {}, getState: () => null, setState() {} },
    target,
  );

  onTestFinished(() => bridge.dispose());
  const { container } = render(
    <FileIconThemeProvider bridge={bridge}>
      <FileTree
        files={files}
        selectedPath="src/file.ts"
        onOpen={() => undefined}
      />
    </FileIconThemeProvider>,
  );
  const send = (next: FileIconTheme, stylesheet: string | null = null) =>
    act(() => {
      target.dispatchEvent(
        new MessageEvent('message', {
          data: {
            requestId: 'icons',
            repositoryId: 'unrelated',
            generation: 0,
            body: { kind: 'file-icon-theme', theme: next, stylesheet },
          },
        }),
      );
    });

  send(theme);
  const leaf = screen.getByRole('treeitem', { name: 'Modified · file.ts' });
  const image = leaf.querySelector('img');

  expect(image).toHaveAttribute('src', 'https://webview.test/typescript.svg');
  await userEvent
    .setup()
    .click(screen.getByRole('treeitem', { name: 'src 1 file' }));
  const folder = container.querySelector('details')!;

  expect(folder.open).toBe(false);
  send(
    {
      ...theme,
      definitions: {
        ...theme.definitions,
        typescript: { className: 'git-file-theme-next-1' },
      },
    },
    'https://webview.test/next.css',
  );
  expect(leaf.querySelector('img')).toBe(image);
  fireEvent.load(document.head.querySelector('link[data-file-icon-theme]')!);
  expect(leaf.querySelector('[data-file-icon]')).toHaveClass(
    'git-file-theme-next-1',
  );
  expect(
    screen.getByRole('treeitem', { name: 'Modified · file.ts', hidden: true }),
  ).toBe(leaf);
  expect(leaf).toHaveAttribute('aria-selected', 'true');
  expect(folder.open).toBe(false);
});

test('obsolete stylesheet loads cannot replace the newest theme and unmount removes owned links', () => {
  const target = new EventTarget();
  const bridge = createBrowserBridge(
    { postMessage() {}, getState: () => null, setState() {} },
    target,
  );

  onTestFinished(() => bridge.dispose());
  const { container, unmount } = render(
    <FileIconThemeProvider bridge={bridge}>
      <FileTree files={files} selectedPath={null} onOpen={() => undefined} />
    </FileIconThemeProvider>,
  );
  const send = (uri: string, stylesheet: string | null) =>
    act(() =>
      target.dispatchEvent(
        new MessageEvent('message', {
          data: {
            requestId: 'icons',
            repositoryId: '',
            generation: 0,
            body: {
              kind: 'file-icon-theme',
              theme: {
                ...theme,
                definitions: { ...theme.definitions, typescript: { uri } },
              },
              stylesheet,
            },
          },
        }),
      ),
    );

  send('https://webview.test/old.svg', 'https://webview.test/old.css');
  const old = document.head.querySelector('link[data-file-icon-theme]')!;

  send('https://webview.test/new.svg', null);
  fireEvent.load(old);
  expect(container.querySelector('[data-file="file"] img')).toHaveAttribute(
    'src',
    'https://webview.test/new.svg',
  );
  unmount();
  expect(document.head.querySelector('link[data-file-icon-theme]')).toBeNull();
});

test('a theme without folder icons follows Explorer while unavailable themes keep Codicon fallback', () => {
  const target = new EventTarget();
  const bridge = createBrowserBridge(
    { postMessage() {}, getState: () => null, setState() {} },
    target,
  );

  onTestFinished(() => bridge.dispose());
  const { container } = render(
    <FileIconThemeProvider bridge={bridge}>
      <FileTree files={files} selectedPath={null} onOpen={() => undefined} />
    </FileIconThemeProvider>,
  );
  const folderIcon = container.querySelector('[data-file-icon="folder"]');

  expect(folderIcon?.querySelector('.codicon-folder')).not.toBeNull();
  act(() =>
    target.dispatchEvent(
      new MessageEvent('message', {
        data: {
          requestId: 'icons',
          repositoryId: '',
          generation: 0,
          body: {
            kind: 'file-icon-theme',
            theme: {
              ...theme,
              associations: { ...theme.associations, folder: undefined },
            },
            stylesheet: null,
          },
        },
      }),
    ),
  );
  expect(container.querySelector('[data-file-icon="folder"]')).toBeNull();
});

test('the None theme suppresses file icons instead of substituting generic icons', () => {
  const target = new EventTarget();
  const bridge = createBrowserBridge(
    { postMessage() {}, getState: () => null, setState() {} },
    target,
  );

  onTestFinished(() => bridge.dispose());
  const { container } = render(
    <FileIconThemeProvider bridge={bridge}>
      <FileTree files={files} selectedPath={null} onOpen={() => undefined} />
    </FileIconThemeProvider>,
  );

  act(() =>
    target.dispatchEvent(
      new MessageEvent('message', {
        data: {
          requestId: 'icons',
          repositoryId: '',
          generation: 0,
          body: {
            kind: 'file-icon-theme',
            theme: {
              ...theme,
              definitions: {},
              associations: {
                fileNames: {},
                fileExtensions: {},
                languageIds: {},
                folderNames: {},
                folderNamesExpanded: {},
              },
            },
            stylesheet: null,
          },
        },
      }),
    ),
  );
  expect(container.querySelector('[data-file-icon="file"]')).toBeNull();
});

test('a declared but unavailable folder asset uses the generic folder fallback', () => {
  const target = new EventTarget();
  const bridge = createBrowserBridge(
    { postMessage() {}, getState: () => null, setState() {} },
    target,
  );

  onTestFinished(() => bridge.dispose());
  const { container } = render(
    <FileIconThemeProvider bridge={bridge}>
      <FileTree files={files} selectedPath={null} onOpen={() => undefined} />
    </FileIconThemeProvider>,
  );

  act(() =>
    target.dispatchEvent(
      new MessageEvent('message', {
        data: {
          requestId: 'icons',
          repositoryId: '',
          generation: 0,
          body: {
            kind: 'file-icon-theme',
            theme: {
              ...theme,
              definitions: { typescript: theme.definitions.typescript },
              associations: { ...theme.associations, folder: 'missing-asset' },
            },
            stylesheet: null,
          },
        },
      }),
    ),
  );
  expect(
    container.querySelector('[data-file-icon="folder"] .codicon-folder'),
  ).not.toBeNull();
});
