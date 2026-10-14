import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { expect, onTestFinished, test, vi } from 'vitest';

import type { PanelBody } from '../../src/shared/messages';
import type { CommitRecord } from '../../src/shared/model';
import type { ViewState } from '../../src/webview/app/model/state';
import { initialView, reduceView } from '../../src/webview/app/model/state';
import { useBrowserState } from '../../src/webview/app/model/useBrowserState';
import { GraphAdapter } from '../../src/webview/pages/log/lib/graph/adapter';
import { HistoryRow } from '../../src/webview/pages/log/ui/history/HistoryRow';
import { createBrowserBridge } from '../../src/webview/shared/api';

const a = 'a'.repeat(40);

const b = 'b'.repeat(40);

const c = 'c'.repeat(40);

const d = 'd'.repeat(40);

const commits: CommitRecord[] = [a, b, c, d].map((sha, index) => ({
  sha,
  parents: index === 3 ? [] : [[b, c, d][index]!],
  message: 'Commit ' + sha[0],
  authorName: 'Author',
  authorEmail: 'author@example.test',
  authorDate: null,
  commitDate: null,
}));

const repository = {
  id: 'one',
  label: 'One',
  rootUri: 'file:///one',
  branch: 'main',
  headSha: a,
};

function host(body: PanelBody, generation = 1, repositoryId = 'one') {
  return {
    kind: 'host' as const,
    message: { requestId: 'fixture', repositoryId, generation, body },
  };
}

function history(rows: CommitRecord[], append = false, target = repository) {
  return {
    kind: 'history' as const,
    repository: target,
    scope: { kind: 'head' as const },
    text: '',
    append,
    page: { commits: rows, refs: [], nextCursor: null, scopeId: 'fixture' },
  };
}

test('row gestures retain Shift and context semantics without giving inactive range members a tab stop', () => {
  const onIntent = vi.fn();
  const onNavigate = vi.fn();
  let data: ViewState = { ...initialView(), repository, commits };

  data = reduceView(data, { kind: 'select-commit', sha: b });
  data = reduceView(data, {
    kind: 'select-commit',
    sha: d,
    gesture: 'extend',
  });
  const graph = new GraphAdapter().layout(commits, 'history')[1]!;

  render(
    <HistoryRow
      data={data}
      commit={commits[1]!}
      graph={graph}
      index={1}
      columns={[400, 100, 130]}
      viewportHeight={280}
      onIntent={onIntent}
      onNavigate={onNavigate}
    />,
  );
  const row = screen.getByRole('row');

  expect(row).toHaveAttribute('aria-selected', 'true');
  expect(row).toHaveAttribute('tabindex', '-1');
  fireEvent.click(row, { shiftKey: true });
  expect(onIntent).toHaveBeenLastCalledWith({
    kind: 'select-commit',
    sha: b,
    gesture: 'extend',
  });
  fireEvent.keyDown(row, { key: 'ArrowDown', shiftKey: true });
  expect(onNavigate).toHaveBeenLastCalledWith(c, 0, 'extend');
  fireEvent.contextMenu(row);
  expect(onIntent).toHaveBeenLastCalledWith({
    kind: 'select-commit',
    sha: b,
    scrollTop: 0,
    gesture: 'context',
  });
  const context = JSON.parse(row.getAttribute('data-vscode-context')!);

  expect(context.commitShas).toEqual([b, c, d]);
  expect(context.commitSelectionCount).toBe(3);
  expect(context.commitCanCherryPick).toBe(true);
});

test('the controller sends the full loaded range while keeping temporary range state out of saved data', () => {
  const api = { getState: () => null, setState: vi.fn(), postMessage: vi.fn() };
  const target = new EventTarget();
  const bridge = createBrowserBridge(api, target);

  onTestFinished(() => bridge.dispose());
  const { result, unmount } = renderHook(() => useBrowserState(bridge));

  act(() => {
    target.dispatchEvent(
      new MessageEvent('message', {
        data: {
          requestId: 'history',
          repositoryId: 'one',
          generation: 1,
          body: {
            kind: 'history',
            repository,
            scope: { kind: 'head' },
            text: '',
            append: false,
            page: { commits, refs: [], nextCursor: null, scopeId: 'fixture' },
          },
        },
      }),
    );
    result.current.onLogIntent({ kind: 'select-commit', sha: b });
    result.current.onLogIntent({
      kind: 'select-commit',
      sha: d,
      gesture: 'extend',
    });
  });
  expect(result.current.state.commitRange.selectedShas).toEqual([b, c, d]);
  expect(api.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
    body: { kind: 'select-commits', shas: [b, c, d], activeSha: d },
  });
  expect(api.setState.mock.calls.at(-1)?.[0]).toMatchObject({
    selection: { sha: d },
  });
  expect(api.setState.mock.calls.at(-1)?.[0]).not.toHaveProperty('commitRange');
  const sent = api.postMessage.mock.calls.length;

  act(() =>
    result.current.onLogIntent({ kind: 'select-commit', sha: 'f'.repeat(40) }),
  );
  expect(api.postMessage).toHaveBeenCalledTimes(sent);
  act(() => result.current.onLogIntent({ kind: 'select-commit', sha: d }));
  expect(api.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
    body: { kind: 'select-commits', shas: [d], activeSha: d },
  });
  expect(api.postMessage).toHaveBeenCalledTimes(sent + 1);
  unmount();
});

test('changing the range around the same active commit preserves its selected file and current host handles', () => {
  const api = { getState: () => null, setState: vi.fn(), postMessage: vi.fn() };
  const target = new EventTarget();
  const bridge = createBrowserBridge(api, target);

  onTestFinished(() => bridge.dispose());
  const { result, unmount } = renderHook(() => useBrowserState(bridge));
  const deliver = (body: PanelBody) =>
    target.dispatchEvent(
      new MessageEvent('message', { data: host(body).message }),
    );

  act(() => {
    deliver(history(commits));
    result.current.onLogIntent({ kind: 'select-commit', sha: b });
    result.current.onLogIntent({
      kind: 'select-commit',
      sha: d,
      gesture: 'extend',
    });
    deliver({ kind: 'details', commit: commits[3]! });
    deliver({
      kind: 'files',
      sha: d,
      parentSha: null,
      files: [
        {
          id: 'root-file',
          oldPath: null,
          newPath: 'thing.ts',
          status: 'added',
        },
      ],
    });
    result.current.request({
      kind: 'open-file',
      fileId: 'root-file',
      preview: true,
    });
  });
  const sent = api.postMessage.mock.calls.length;

  act(() =>
    result.current.onLogIntent({
      kind: 'select-commit',
      sha: d,
      gesture: 'context',
    }),
  );
  expect(result.current.state.selectedFilePath).toBe('thing.ts');
  expect(result.current.state.details?.sha).toBe(d);
  expect(api.postMessage).toHaveBeenCalledTimes(sent);
  act(() => result.current.onLogIntent({ kind: 'select-commit', sha: d }));
  expect(result.current.state.commitRange.selectedShas).toEqual([d]);
  expect(result.current.state.selectedFilePath).toBe('thing.ts');
  expect(result.current.state.details?.sha).toBe(d);
  expect(api.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
    body: { kind: 'select-commits', shas: [d], activeSha: d },
  });
  expect(api.postMessage).toHaveBeenCalledTimes(sent + 1);
  act(() => result.current.onLogIntent({ kind: 'select-commit', sha: c }));
  expect(result.current.state.selectedFilePath).toBeNull();
  expect(result.current.state.details).toBeNull();
  unmount();
});

test('same-active selection retries failed files but a successfully empty comparison keeps its handles', () => {
  const api = { getState: () => null, setState: vi.fn(), postMessage: vi.fn() };
  const target = new EventTarget();
  const bridge = createBrowserBridge(api, target);

  onTestFinished(() => bridge.dispose());
  const { result, unmount } = renderHook(() => useBrowserState(bridge));
  const deliver = (body: PanelBody) =>
    target.dispatchEvent(
      new MessageEvent('message', { data: host(body).message }),
    );

  act(() => {
    deliver(history(commits));
    result.current.onLogIntent({ kind: 'select-commit', sha: b });
    deliver({ kind: 'details', commit: commits[1]! });
    deliver({ kind: 'error', message: 'File read failed' });
  });
  const sent = api.postMessage.mock.calls.length;

  act(() =>
    result.current.onLogIntent({
      kind: 'select-commit',
      sha: b,
      gesture: 'context',
    }),
  );
  expect(api.postMessage).toHaveBeenCalledTimes(sent + 1);
  expect(api.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
    body: { kind: 'select-commits', shas: [b], activeSha: b },
  });
  act(() => {
    deliver({ kind: 'files', sha: b, parentSha: c, files: [] });
    result.current.onLogIntent({
      kind: 'select-commit',
      sha: b,
      gesture: 'context',
    });
  });
  expect(api.postMessage).toHaveBeenCalledTimes(sent + 1);
  unmount();
});
