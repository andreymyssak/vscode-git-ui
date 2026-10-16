import { expect, test } from 'vitest';

import type { OperationResult } from '../../src/shared/model';
import { initialView, reduceView } from '../../src/webview/app/model/state';
import { a, fixture, page } from '../fixtures/controller';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

for (const result of [
  { kind: 'success', backend: 'api' },
  { kind: 'error', backend: 'api', message: 'Fetch failed' },
  { kind: 'cancelled', backend: null },
] satisfies OperationResult[])
  test(`a ${result.kind} Update retires prewrite history before publishing its completed Git phase`, async (t) => {
    const initial = {
      ...page([a]),
      refs: page([a]).refs.map((ref) => ({
        ...ref,
        tracking: { upstream: 'refs/remotes/origin/main', ahead: 0, behind: 3 },
      })),
    };
    const fresh = {
      ...initial,
      refs: initial.refs.map((ref) => ({
        ...ref,
        tracking: {
          ...ref.tracking,
          behind: result.kind === 'success' ? 0 : 3,
        },
      })),
    };
    const write = deferred<OperationResult>();
    const writing = deferred<void>();
    const oldGraph = deferred<typeof initial>();
    const browsingStarted = deferred<void>();
    const refreshing = deferred<void>();
    const metadata = deferred<void>();
    const metadataSent = deferred<void>();
    const graph = deferred<typeof fresh>();
    let state = initialView();
    const browsing: Promise<void>[] = [];
    let inGap = false;
    const gapReadiness: boolean[] = [];
    const f = fixture(true, true, {
      send: async (message) => {
        state = reduceView(state, { kind: 'host', message });
        if (inGap) gapReadiness.push(state.referencesReady);
        if (
          !inGap &&
          message.body.kind === 'operation-progress' &&
          message.body.operation?.phase === 'refreshing'
        ) {
          inGap = true;
          // The old graph finishes while the webview acknowledges Git completion.
          oldGraph.resolve(initial);
          await Promise.all(browsing);
        }
      },
    });
    let reads = 0;

    f.adapter.history = async (_id, _input, _signal, onReferences) => {
      if (++reads === 1) return initial;
      if (reads === 2) {
        await onReferences?.(initial.refs);
        browsingStarted.resolve();

        return oldGraph.promise;
      }

      refreshing.resolve();
      await metadata.promise;
      await onReferences?.(fresh.refs);
      metadataSent.resolve();

      return graph.promise;
    };

    f.adapter.operate = async () => {
      writing.resolve();

      return write.promise;
    };

    await f.controller.selectRepository('one');
    const pending = f.controller.handle(
      f.request({
        kind: 'action',
        action: { kind: 'update-branch', refId: 'refs/heads/main' },
      }),
    );

    t.onTestFinished(async () => {
      write.resolve(result);
      oldGraph.resolve(initial);
      metadata.resolve();
      graph.resolve(fresh);
      await Promise.allSettled([pending, ...browsing]);
      f.controller.dispose();
    });
    await writing.promise;
    browsing.push(
      f.controller.handle(
        f.request({
          kind: 'history',
          scope: { kind: 'all' },
          text: '',
          cursor: null,
        }),
      ),
    );
    await browsingStarted.promise;
    f.fireHistoryEvent();
    write.resolve(result);
    await refreshing.promise;
    expect(gapReadiness).not.toContain(true);
    expect(state.referencesReady).toBe(false);
    metadata.resolve();
    await metadataSent.promise;
    expect(state.referencesReady).toBe(true);
    expect(state.refs[0]?.tracking?.behind).toBe(
      result.kind === 'success' ? 0 : 3,
    );
    expect(state.loading).toBe(true);
    graph.resolve(fresh);
    await pending;
    expect(state.operation).toBeNull();
  });
