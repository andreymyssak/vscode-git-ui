import { act, renderHook } from '@testing-library/react';
import { expect, onTestFinished, test, vi } from 'vitest';

import type { PanelBody, Result } from '../../src/shared/messages';
import { useBrowserState } from '../../src/webview/app/model/useBrowserState';
import {
  selectBranches,
  selectDetails,
  selectHistory,
  selectToolbar,
  useLogSelector,
} from '../../src/webview/pages/log/model/selectors';
import { createBrowserBridge } from '../../src/webview/shared/api';

test('unrelated activity does not rerender a view subscriber', () => {
  const target = new EventTarget();
  const bridge = createBrowserBridge(
    { getState: () => null, setState: () => {}, postMessage: () => {} },
    target,
  );

  onTestFinished(() => bridge.dispose());
  const render = vi.fn();
  const hook = renderHook(() => {
    const controller = useBrowserState(bridge, (state) => ({
      activeView: state.activeView,
    }));

    render();

    return controller;
  });
  const deliver = (body: PanelBody) =>
    act(() => {
      target.dispatchEvent(
        new MessageEvent<Result<PanelBody>>('message', {
          data: { repositoryId: 'one', requestId: 'host', generation: 1, body },
        }),
      );
    });

  deliver({
    kind: 'loading',
    repository: {
      id: 'one',
      label: 'One',
      rootUri: 'file:///one',
      branch: 'main',
      headSha: null,
    },
    scope: { kind: 'head' },
    text: '',
  });
  const before = render.mock.calls.length;

  deliver({
    kind: 'operation-progress',
    operation: {
      label: 'Fetching',
      section: 'branches',
      phase: 'running',
      refIds: [],
    },
  });
  deliver({ kind: 'worktrees-loading', loading: true });
  expect(render).toHaveBeenCalledTimes(before);
  act(() => hook.result.current.setActiveView('worktrees'));
  expect(hook.result.current.state.activeView).toBe('worktrees');
  expect(render).toHaveBeenCalledTimes(before + 1);
  hook.unmount();
});

test('Log slices retain snapshots through progress and notify only consumers of changed fields', () => {
  const target = new EventTarget();
  const bridge = createBrowserBridge(
    { getState: () => null, setState: () => {}, postMessage: () => {} },
    target,
  );

  onTestFinished(() => bridge.dispose());
  const controller = renderHook(() => useBrowserState(bridge));
  const source = controller.result.current.store;
  const branchesRender = vi.fn();
  const historyRender = vi.fn();
  const detailsRender = vi.fn();
  const toolbarRender = vi.fn();
  const branches = renderHook(() => {
    const snapshot = useLogSelector(source, selectBranches);

    branchesRender();

    return snapshot;
  });
  const history = renderHook(() => {
    const snapshot = useLogSelector(source, selectHistory);

    historyRender();

    return snapshot;
  });
  const details = renderHook(() => {
    const snapshot = useLogSelector(source, selectDetails);

    detailsRender();

    return snapshot;
  });
  const toolbar = renderHook(() => {
    const snapshot = useLogSelector(source, selectToolbar);

    toolbarRender();

    return snapshot;
  });
  const deliver = (body: PanelBody) =>
    act(() => {
      target.dispatchEvent(
        new MessageEvent<Result<PanelBody>>('message', {
          data: { repositoryId: 'one', requestId: 'host', generation: 1, body },
        }),
      );
    });

  deliver({
    kind: 'loading',
    repository: {
      id: 'one',
      label: 'One',
      rootUri: 'file:///one',
      branch: 'main',
      headSha: null,
    },
    scope: { kind: 'head' },
    text: '',
  });
  for (const rendered of [
    branchesRender,
    historyRender,
    detailsRender,
    toolbarRender,
  ])
    rendered.mockClear();
  const before = {
    branches: branches.result.current,
    history: history.result.current,
    details: details.result.current,
    toolbar: toolbar.result.current,
  };

  deliver({
    kind: 'operation-progress',
    operation: {
      label: 'Fetching',
      section: 'branches',
      phase: 'running',
      refIds: [],
    },
  });
  deliver({ kind: 'worktrees-loading', loading: true });
  expect(branchesRender).toHaveBeenCalledTimes(1);
  expect(historyRender).not.toHaveBeenCalled();
  expect(detailsRender).not.toHaveBeenCalled();
  expect(toolbarRender).not.toHaveBeenCalled();
  expect(history.result.current).toBe(before.history);
  expect(details.result.current).toBe(before.details);
  expect(toolbar.result.current).toBe(before.toolbar);
  const currentBranches = branches.result.current;

  act(() =>
    controller.result.current.onLogIntent({ kind: 'show-hash', show: true }),
  );
  expect(historyRender).toHaveBeenCalledTimes(1);
  expect(toolbarRender).toHaveBeenCalledTimes(1);
  expect(branchesRender).toHaveBeenCalledTimes(1);
  expect(detailsRender).not.toHaveBeenCalled();
  expect(branches.result.current).toBe(currentBranches);
  for (const hook of [branches, history, details, toolbar, controller])
    hook.unmount();
});
