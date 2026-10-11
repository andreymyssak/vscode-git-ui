import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type { PanelBody, Result } from '../../src/shared/messages';
import type { CommitRecord } from '../../src/shared/model';
import type { ViewState } from '../../src/webview/app/model/state';
import { initialView, reduceView } from '../../src/webview/app/model/state';
import { useHistoryPaging } from '../../src/webview/pages/log/model/useHistoryPaging';

const repository = {
  id: 'one',
  label: 'One',
  rootUri: 'file:///one',
  branch: 'main',
  headSha: 'a'.repeat(40),
};
const commits: CommitRecord[] = Array.from({ length: 200 }, (_, index) => ({
  sha: (index + 1).toString(16).padStart(40, '0'),
  parents: [],
  message: 'Commit',
  authorName: null,
  authorEmail: null,
  authorDate: null,
  commitDate: null,
}));
const result = (body: PanelBody): Result<PanelBody> => ({
  repositoryId: repository.id,
  requestId: 'page-attempt',
  generation: 1,
  body,
});
const loaded = (): ViewState =>
  reduceView(
    { ...initialView(), scrollTop: 4200 },
    {
      kind: 'host',
      message: result({
        kind: 'history',
        append: false,
        restoring: false,
        repository,
        scope: { kind: 'head' },
        text: '',
        page: {
          commits,
          refs: [],
          nextCursor: 'page-two',
          scopeId: 'snapshot-one',
        },
      }),
    },
  );

test('scrolling away and back retries a cursor after its transient page failure', () => {
  const onIntent = vi.fn();
  let state = loaded();
  const { rerender } = renderHook(
    ({ data }) => useHistoryPaging(data, 200, onIntent),
    { initialProps: { data: state } },
  );

  expect(onIntent).toHaveBeenCalledTimes(1);
  expect(onIntent.mock.calls[0]?.[0]).toMatchObject({
    kind: 'request',
    body: { kind: 'history', cursor: 'page-two' },
  });
  state = reduceView(state, {
    kind: 'update',
    patch: { loading: true },
  });
  rerender({ data: state });
  expect(onIntent).toHaveBeenCalledTimes(1);

  state = reduceView(state, {
    kind: 'host',
    message: result({
      kind: 'error',
      message: 'Temporary object read failure',
    }),
  });
  rerender({ data: state });
  expect(state.loading).toBe(false);
  expect(state.error).toBe('Temporary object read failure');
  expect(state.nextCursor).toBe('page-two');
  expect(state.commits).toHaveLength(200);
  expect(onIntent).toHaveBeenCalledTimes(1);

  // A deliberate new boundary crossing retries; an idle failed viewport must not spin.
  state = reduceView(state, {
    kind: 'update',
    patch: { scrollTop: 1000 },
  });
  rerender({ data: state });
  expect(onIntent).toHaveBeenCalledTimes(1);
  state = reduceView(state, {
    kind: 'update',
    patch: { scrollTop: 4200 },
  });
  rerender({ data: state });
  expect(onIntent).toHaveBeenCalledTimes(2);
  expect(onIntent.mock.calls[1]?.[0]).toMatchObject({
    kind: 'request',
    body: { kind: 'history', cursor: 'page-two' },
  });
});

test('a fresh history generation releases the attempted cursor ownership', () => {
  const onIntent = vi.fn();
  const state = loaded();
  const { rerender } = renderHook(
    ({ data }) => useHistoryPaging(data, 200, onIntent),
    { initialProps: { data: state } },
  );

  expect(onIntent).toHaveBeenCalledTimes(1);
  rerender({ data: { ...state, generation: 2, nextCursor: 'fresh-page-two' } });
  expect(onIntent).toHaveBeenCalledTimes(2);
  expect(onIntent.mock.calls[1]?.[0]).toMatchObject({
    body: { kind: 'history', cursor: 'fresh-page-two' },
  });
});

test('scrolling cannot duplicate a page request that has not settled', () => {
  const onIntent = vi.fn();
  const state = loaded();
  const { rerender } = renderHook(
    ({ data }) => useHistoryPaging(data, 200, onIntent),
    { initialProps: { data: state } },
  );

  rerender({ data: { ...state, scrollTop: 1000 } });
  rerender({ data: { ...state, scrollTop: 4200 } });
  expect(onIntent).toHaveBeenCalledTimes(1);
  rerender({ data: { ...state, loading: true, scrollTop: 1000 } });
  rerender({ data: { ...state, loading: true } });
  expect(onIntent).toHaveBeenCalledTimes(1);
});
