import { act, renderHook } from '@testing-library/react';
import { expect, onTestFinished, test, vi } from 'vitest';

import type {
  PanelBody,
  Request,
  RequestBody,
  Result,
} from '../../src/shared/messages';
import type { HistoryFilters } from '../../src/shared/model';
import { useBrowserState } from '../../src/webview/app/model/useBrowserState';
import { createBrowserBridge } from '../../src/webview/shared/api';

function scrollController() {
  const target = new EventTarget();
  const requests: Request<RequestBody>[] = [];
  const setState = vi.fn();
  const bridge = createBrowserBridge(
    {
      getState: () => null,
      setState,
      postMessage: (request) => {
        requests.push(request);
      },
    },
    target,
  );

  onTestFinished(() => bridge.dispose());
  const controller = renderHook(() => useBrowserState(bridge));
  const repository = {
    id: 'one',
    label: 'One',
    rootUri: 'file:///one',
    branch: 'main',
    headSha: '1'.padStart(40, '0'),
  };
  const deliver = (body: PanelBody, generation = 1) =>
    target.dispatchEvent(
      new MessageEvent<Result<PanelBody>>('message', {
        data: { repositoryId: 'one', requestId: 'host', generation, body },
      }),
    );

  act(() =>
    deliver({
      kind: 'history',
      repository,
      scope: { kind: 'head' },
      text: '',
      append: false,
      page: {
        commits: Array.from({ length: 20 }, (_, index) => ({
          sha: (index + 1).toString(16).padStart(40, '0'),
          parents: [],
          message: 'Loaded commit',
          authorName: null,
          authorEmail: null,
          authorDate: null,
          commitDate: null,
        })),
        refs: [],
        nextCursor: '200',
        scopeId: 'fixture',
      },
    }),
  );

  return { ...controller, requests, repository, deliver, bridge, setState };
}

test('progress and transient read activity do not rewrite durable view state', () => {
  const f = scrollController();

  f.setState.mockClear();
  act(() => {
    f.deliver({
      kind: 'operation-progress',
      operation: {
        phase: 'running',
        label: 'Fetching remotes',
        section: 'branches',
        refIds: [],
      },
    });
  });
  expect(f.result.current.state.operation?.label).toBe('Fetching remotes');
  expect(f.setState).not.toHaveBeenCalled();
  act(() => f.deliver({ kind: 'worktrees-loading', loading: true }));
  expect(f.result.current.state.worktreesLoading).toBe(true);
  expect(f.setState).not.toHaveBeenCalled();
  act(() => f.result.current.onLogIntent({ kind: 'show-hash', show: true }));
  expect(f.setState).toHaveBeenCalledTimes(1);
  expect(f.setState).toHaveBeenLastCalledWith(
    expect.objectContaining({ repositoryId: 'one', showHash: true }),
  );
  f.unmount();
});

test('hiding branches persists layout without querying or losing preferred widths', () => {
  let saved: unknown;
  const postMessage = vi.fn();
  const target = new EventTarget();
  const bridge = createBrowserBridge(
    {
      getState: () => saved,
      setState: (value) => {
        saved = value;
      },
      postMessage,
    },
    target,
  );

  onTestFinished(() => bridge.dispose());
  const f = renderHook(() => useBrowserState(bridge));

  act(() =>
    target.dispatchEvent(
      new MessageEvent<Result<PanelBody>>('message', {
        data: {
          repositoryId: 'one',
          requestId: 'host',
          generation: 1,
          body: {
            kind: 'history',
            append: false,
            scope: { kind: 'head' },
            text: '',
            repository: {
              id: 'one',
              label: 'One',
              rootUri: 'file:///one',
              branch: 'main',
              headSha: null,
            },
            page: {
              commits: [],
              refs: [],
              nextCursor: null,
              scopeId: 'fixture',
            },
          },
        },
      }),
    ),
  );
  // The bridge announces readiness on mount; layout changes must add no request.
  postMessage.mockClear();
  act(() =>
    f.result.current.onLogIntent({ kind: 'pane-widths', widths: [280, 360] }),
  );
  act(() =>
    f.result.current.onLogIntent({
      kind: 'branches-collapsed',
      collapsed: true,
    }),
  );
  expect(f.result.current.state.branchesCollapsed).toBe(true);
  expect(f.result.current.state.paneWidths).toEqual([280, 360]);
  expect(postMessage).not.toHaveBeenCalled();
  f.unmount();
  const restored = renderHook(() => useBrowserState(bridge));

  expect(restored.result.current.state.branchesCollapsed).toBe(true);
  expect(restored.result.current.state.paneWidths).toEqual([280, 360]);
  restored.unmount();
});

test('branch filter activation selects its action target, but search and date changes preserve an independent branch selection', () => {
  const f = scrollController();

  act(() =>
    f.result.current.onLogIntent({
      kind: 'apply-scope',
      scope: { kind: 'ref', refId: 'refs/heads/topic' },
    }),
  );
  expect(f.result.current.state.selectedRefId).toBe('refs/heads/topic');
  act(() =>
    f.result.current.onLogIntent({
      kind: 'select-ref',
      refId: 'refs/heads/main',
    }),
  );
  act(() =>
    f.result.current.onLogIntent({
      kind: 'filters',
      filters: { ...f.result.current.state.filters, date: '7d' },
    }),
  );
  expect(f.result.current.state.selectedRefId).toBe('refs/heads/main');
  act(() => f.result.current.onLogIntent({ kind: 'search', text: 'message' }));
  expect(f.result.current.state.selectedRefId).toBe('refs/heads/main');
  expect(f.requests.at(-1)?.body).toMatchObject({
    kind: 'history',
    scope: { kind: 'ref', refId: 'refs/heads/topic' },
    text: 'message',
    filters: { date: '7d' },
  });
  act(() =>
    f.result.current.onLogIntent({
      kind: 'apply-scope',
      scope: { kind: 'all' },
    }),
  );
  expect(f.result.current.state.selectedRefId).toBeNull();
  f.unmount();
});

test('a scroll anchor reaches the host in the same gesture before a background refresh can start', () => {
  const fixture = scrollController();
  const anchor = { sha: 'b'.padStart(40, '0'), offset: 7 };

  act(() =>
    fixture.result.current.onLogIntent({
      kind: 'scroll',
      scrollTop: 227,
      anchor,
    }),
  );
  expect(fixture.requests.at(-1)).toMatchObject({
    repositoryId: 'one',
    generation: 1,
    body: { kind: 'anchor', anchor },
  });
  fixture.unmount();
});

test('a restoring history clamp cannot replace the latest scroll anchor while normal page loading remains scrollable', () => {
  const fixture = scrollController();
  const anchor = { sha: 'b'.padStart(40, '0'), offset: 7 };

  act(() => {
    fixture.result.current.onLogIntent({
      kind: 'request',
      body: {
        kind: 'history',
        scope: { kind: 'head' },
        text: '',
        cursor: '200',
      },
    });
    fixture.result.current.onLogIntent({
      kind: 'scroll',
      scrollTop: 227,
      anchor,
    });
  });
  expect(fixture.result.current.state).toMatchObject({
    scrollTop: 227,
    anchor,
    loading: true,
    restoring: false,
  });
  act(() =>
    fixture.deliver(
      {
        kind: 'loading',
        repository: fixture.repository,
        scope: { kind: 'head' },
        text: '',
        preserve: true,
      },
      2,
    ),
  );
  const sent = [...fixture.requests];

  act(() =>
    fixture.result.current.onLogIntent({
      kind: 'scroll',
      scrollTop: 0,
      anchor: null,
    }),
  );
  expect(fixture.result.current.state).toMatchObject({
    scrollTop: 227,
    anchor,
    loading: true,
    restoring: true,
  });
  expect(fixture.requests).toEqual(sent);
  fixture.unmount();
});

test('independent controllers retain separate state and request snapshots', () => {
  const firstApi = {
    getState: () => null,
    setState: vi.fn(),
    postMessage: vi.fn(),
  };
  const secondApi = {
    getState: () => null,
    setState: vi.fn(),
    postMessage: vi.fn(),
  };
  const firstBridge = createBrowserBridge(firstApi, new EventTarget());

  onTestFinished(() => firstBridge.dispose());
  const secondBridge = createBrowserBridge(secondApi, new EventTarget());

  onTestFinished(() => secondBridge.dispose());
  const first = renderHook(() => useBrowserState(firstBridge));
  const second = renderHook(() => useBrowserState(secondBridge));

  act(() => {
    first.result.current.onLogIntent({ kind: 'search', text: 'first' });
    first.result.current.onLogIntent({ kind: 'search', text: 'new first' });
    second.result.current.onLogIntent({
      kind: 'apply-scope',
      scope: { kind: 'all' },
    });
  });
  expect(first.result.current.state).toMatchObject({
    text: 'new first',
    generation: 2,
  });
  expect(second.result.current.state).toMatchObject({
    text: '',
    generation: 1,
  });
  expect(firstApi.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
    generation: 2,
    body: { kind: 'history', text: 'new first', scope: { kind: 'head' } },
  });
  first.unmount();
  act(() => second.result.current.request({ kind: 'refresh' }));
  expect(secondApi.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
    generation: 1,
    body: { kind: 'refresh' },
  });
  second.unmount();
});

test('filter intents keep one query snapshot and reject author picker replies from an obsolete generation', () => {
  const api = { getState: () => null, setState: vi.fn(), postMessage: vi.fn() };
  const target = new EventTarget();
  const bridge = createBrowserBridge(api, target);

  onTestFinished(() => bridge.dispose());
  const { result, unmount } = renderHook(() => useBrowserState(bridge));
  const repository = {
    id: 'one',
    label: 'One',
    rootUri: 'file:///one',
    branch: 'main',
    headSha: null,
  };
  const filters: HistoryFilters = {
    regex: true,
    matchCase: true,
    author: { kind: 'me' },
    date: '7d',
  };

  act(() => {
    target.dispatchEvent(
      new MessageEvent<Result<PanelBody>>('message', {
        data: {
          repositoryId: 'one',
          requestId: 'host',
          generation: 1,
          body: {
            kind: 'history',
            repository,
            scope: { kind: 'head' },
            text: '',
            append: false,
            page: {
              commits: [],
              refs: [],
              nextCursor: null,
              scopeId: 'fixture',
            },
          },
        },
      }),
    );
    result.current.onLogIntent({ kind: 'filters', filters });
  });
  expect(api.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
    generation: 2,
    body: { kind: 'history', filters, cursor: null },
  });
  const sent = api.postMessage.mock.calls.length;

  act(() =>
    target.dispatchEvent(
      new MessageEvent<Result<PanelBody>>('message', {
        data: {
          repositoryId: 'one',
          requestId: 'host',
          generation: 1,
          body: {
            kind: 'filters',
            filters: { ...filters, author: { kind: 'all' } },
          },
        },
      }),
    ),
  );
  expect(result.current.state.filters).toEqual(filters);
  expect(api.postMessage).toHaveBeenCalledTimes(sent);
  act(() =>
    target.dispatchEvent(
      new MessageEvent<Result<PanelBody>>('message', {
        data: {
          repositoryId: 'one',
          requestId: 'host',
          generation: 2,
          body: {
            kind: 'filters',
            filters: { ...filters, author: { kind: 'all' } },
          },
        },
      }),
    ),
  );
  expect(api.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
    generation: 3,
    body: { kind: 'history', filters: { ...filters, author: { kind: 'all' } } },
  });
  expect(api.setState.mock.calls.at(-1)?.[0]).toMatchObject({
    filters: { ...filters, author: { kind: 'all' } },
  });
  unmount();
});
test('scope and search intents send the newly reduced generation', () => {
  const api = { getState: () => null, setState: vi.fn(), postMessage: vi.fn() };
  const bridge = createBrowserBridge(api, new EventTarget());

  onTestFinished(() => bridge.dispose());
  const { result, unmount } = renderHook(() => useBrowserState(bridge));

  act(() => {
    result.current.onLogIntent({ kind: 'apply-scope', scope: { kind: 'all' } });
    result.current.onLogIntent({ kind: 'search', text: 'topic' });
    expect(api.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      generation: 2,
      body: { kind: 'history', scope: { kind: 'all' }, text: 'topic' },
    });
  });
  expect(result.current.state.generation).toBe(2);
  unmount();
});
test('pending restoration retains saved preferences until newer user selection', () => {
  const sha = 'a'.repeat(40);
  const newer = 'b'.repeat(40);
  const target = new EventTarget();
  const saved = {
    repositoryId: 'one',
    activeView: 'log',
    scope: { kind: 'head' },
    text: '',
    selectedRefId: null,
    selection: { sha, parentSha: null, filePath: null },
    anchor: null,
    paneWidths: [220, 350],
    historyColumnWidths: [900, 800],
  };
  const api = {
    getState: () => saved,
    setState: vi.fn(),
    postMessage: vi.fn(),
  };
  const bridge = createBrowserBridge(api, target);

  onTestFinished(() => bridge.dispose());
  const { result, unmount } = renderHook(() => useBrowserState(bridge));
  const repository = {
    id: 'one',
    label: 'One',
    rootUri: 'file:///one',
    branch: 'main',
    headSha: sha,
  };

  act(() => {
    target.dispatchEvent(
      new MessageEvent<Result<PanelBody>>('message', {
        data: {
          repositoryId: 'one',
          requestId: 'host',
          generation: 1,
          body: {
            kind: 'setup',
            state: 'ready',
            message: '',
            repositories: [repository],
          },
        },
      }),
    );
    target.dispatchEvent(
      new MessageEvent<Result<PanelBody>>('message', {
        data: {
          repositoryId: 'one',
          requestId: 'host',
          generation: 1,
          body: {
            kind: 'history',
            repository,
            scope: { kind: 'head' },
            text: '',
            append: false,
            page: {
              commits: [sha, newer].map((identity) => ({
                sha: identity,
                parents: [],
                message: 'Loaded commit',
                authorName: null,
                authorEmail: null,
                authorDate: null,
                commitDate: null,
              })),
              refs: [],
              nextCursor: null,
              scopeId: 'fixture',
            },
          },
        },
      }),
    );
  });
  expect(api.setState).not.toHaveBeenCalled();
  expect(result.current.state.historyColumnWidths).toEqual([900, 800]);
  act(() => result.current.onLogIntent({ kind: 'select-commit', sha: newer }));
  expect(api.setState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      selection: expect.objectContaining({ sha: newer }),
      historyColumnWidths: [900, 800],
    }),
  );
  unmount();
});

test('presentation changes retain selected commits, filters and generation without querying the host', () => {
  const f = scrollController();
  const sha = '1'.padStart(40, '0');

  act(() => f.result.current.onLogIntent({ kind: 'select-commit', sha }));
  const before = f.result.current.state;
  const requests = f.requests.length;
  const presentation = {
    ...before.presentation,
    showAuthor: false,
    highlightCurrentBranch: false,
  };

  act(() =>
    f.result.current.onLogIntent({ kind: 'presentation', presentation }),
  );
  expect(f.result.current.state.presentation).toEqual(presentation);
  expect(f.result.current.state.selectedSha).toBe(sha);
  expect(f.result.current.state.generation).toBe(before.generation);
  expect(f.result.current.state.filters).toEqual(before.filters);
  expect(f.requests).toHaveLength(requests);
  f.unmount();
});

test('host commit navigation activates Log from Worktrees', () => {
  const controller = scrollController();

  act(() => controller.result.current.setActiveView('worktrees'));
  expect(controller.result.current.state.activeView).toBe('worktrees');
  act(() => controller.deliver({ kind: 'focus-log' }));
  expect(controller.result.current.state.activeView).toBe('log');
});
