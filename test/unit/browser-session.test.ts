import { expect, onTestFinished, test, vi } from 'vitest';

import type { PanelBody, Result } from '../../src/shared/messages';
import { createBrowserSession } from '../../src/webview/app/model/browser-session';
import { createBrowserBridge } from '../../src/webview/shared/api';

function fixture() {
  const target = new EventTarget();
  const api = { getState: () => null, setState: vi.fn(), postMessage: vi.fn() };
  const bridge = createBrowserBridge(api, target);
  const session = createBrowserSession(bridge);
  const stop = session.mount();

  onTestFinished(() => {
    stop();
    bridge.dispose();
  });
  const deliver = (body: PanelBody) =>
    target.dispatchEvent(
      new MessageEvent<Result<PanelBody>>('message', {
        data: { repositoryId: 'one', requestId: 'host', generation: 1, body },
      }),
    );

  deliver({
    kind: 'history',
    repository: {
      id: 'one',
      label: 'One',
      rootUri: 'file:///one',
      branch: 'main',
      headSha: null,
    },
    scope: { kind: 'head' },
    text: '',
    append: false,
    page: {
      commits: ['a', 'b'].map((identity) => ({
        sha: identity.repeat(40),
        parents: [],
        message: identity,
        authorName: null,
        authorEmail: null,
        authorDate: null,
        commitDate: null,
      })),
      refs: [],
      nextCursor: null,
      scopeId: 'fixture',
    },
  });

  return { session, api, deliver, stop };
}

test.each(['scope', 'search', 'filters', 'selection'] as const)(
  '%s intent publishes one complete transition before sending its request',
  (kind) => {
    const { session, api } = fixture();
    const snapshots: ReturnType<typeof session.store.getState>[] = [];

    session.store.subscribe((state) => snapshots.push(state));
    api.setState.mockClear();
    api.postMessage.mockImplementation(() => {
      expect(snapshots).toHaveLength(1);
      expect(session.store.getState()).toBe(snapshots[0]);
    });
    switch (kind) {
      case 'scope':
        session.onLogIntent({ kind: 'apply-scope', scope: { kind: 'all' } });
        break;
      case 'search':
        session.onLogIntent({ kind: 'search', text: 'topic' });
        break;
      case 'filters':
        session.onLogIntent({
          kind: 'filters',
          filters: {
            regex: true,
            matchCase: false,
            author: { kind: 'all' },
            date: '7d',
          },
        });
        break;
      case 'selection':
        session.onLogIntent({
          kind: 'select-commit',
          sha: 'b'.repeat(40),
          scrollTop: 22,
        });
        break;
    }

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject(
      kind === 'selection'
        ? { selectedSha: 'b'.repeat(40), scrollTop: 22, generation: 1 }
        : { generation: 2, loading: true, commits: [] },
    );
    expect(api.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      generation: kind === 'selection' ? 1 : 2,
      repositoryId: 'one',
    });
    expect(api.setState).toHaveBeenCalledTimes(1);
  },
);

test('unmounting a session releases its listener and preserves another controller', () => {
  const first = fixture();
  const second = fixture();

  first.session.onLogIntent({ kind: 'search', text: 'first' });
  first.stop();
  const snapshot = first.session.store.getState();

  first.deliver({ kind: 'worktrees-loading', loading: true });
  second.deliver({ kind: 'worktrees-loading', loading: true });
  second.session.onLogIntent({ kind: 'search', text: 'second' });
  expect(first.session.store.getState()).toBe(snapshot);
  expect(second.session.store.getState()).toMatchObject({
    text: 'second',
    generation: 2,
  });
  expect(second.api.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
    repositoryId: 'one',
    generation: 2,
    body: { kind: 'history', text: 'second' },
  });
});
