import { assert, expect, test } from 'vitest';

import type { UserAction } from '../../src/shared/messages';
import type { OperationResult } from '../../src/shared/model';
import { a, fixture, page } from '../fixtures/controller';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

const history = {
  ...page([a]),
  refs: [
    ...page([]).refs,
    { ...page([]).refs[0]!, id: 'refs/heads/topic', name: 'topic' },
  ],
};

for (const action of [
  { kind: 'delete-branch', refId: 'refs/heads/topic' },
  { kind: 'rename-branch', refId: 'refs/heads/topic' },
  { kind: 'create-branch', refId: 'refs/heads/topic' },
  { kind: 'create-branch-checkout', refId: 'refs/heads/topic' },
  { kind: 'checkout', refId: 'refs/heads/topic' },
  { kind: 'fetch-all' },
  { kind: 'tag-from-commit', sha: a },
] satisfies UserAction[])
  test(`${action.kind} shows progress until its automatic refresh finishes`, async (t) => {
    const f = fixture(true, true, {
      askRenameBranch: async () => 'renamed',
      askBranchName: async () => 'new-branch',
      askTagName: async () => 'v1',
    });
    const write = deferred<OperationResult>();
    const started = deferred<void>();
    const refreshed = deferred<typeof history>();
    const refreshing = deferred<void>();
    let reads = 0;
    let writes = 0;

    f.adapter.history = async () => {
      if (++reads === 1) return history;
      refreshing.resolve();

      return refreshed.promise;
    };

    f.adapter.operate = async () => {
      writes++;
      started.resolve();

      return write.promise;
    };

    await f.controller.selectRepository('one');
    if (action.kind === 'tag-from-commit')
      await f.controller.handle(f.request({ kind: 'select-commit', sha: a }));
    const pending = f.controller.handle(f.request({ kind: 'action', action }));

    t.onTestFinished(async () => {
      write.resolve({ kind: 'success', backend: 'api' });
      refreshed.resolve(history);
      await pending;
      f.controller.dispose();
    });
    await started.promise;
    await f.controller.handle(f.request({ kind: 'action', action }));
    expect(writes).toBe(1);
    expect(f.sent.map((message) => message.body)).toContainEqual({
      kind: 'operation-progress',
      operation: expect.objectContaining({ phase: 'running' }),
    });
    f.fireHistoryEvent();
    write.resolve({ kind: 'success', backend: 'api' });
    await refreshing.promise;
    expect(f.sent.map((message) => message.body)).toContainEqual({
      kind: 'operation-progress',
      operation: expect.objectContaining({ phase: 'refreshing' }),
    });
    expect(f.sent.at(-1)?.body).not.toEqual({
      kind: 'operation-progress',
      operation: null,
    });
    refreshed.resolve(history);
    await pending;
    expect(f.sent.at(-1)?.body).toEqual({
      kind: 'operation-progress',
      operation: null,
    });
    expect(reads).toBe(2);
  });

test('deleted references are published before a slow replacement graph finishes', async (t) => {
  const f = fixture();
  const refreshed = deferred<typeof history>();
  const refreshing = deferred<void>();
  let reads = 0;

  f.adapter.history = async (_id, _input, _signal, onReferences) => {
    if (++reads === 1) return history;
    await onReferences?.(page([]).refs);
    refreshing.resolve();

    return refreshed.promise;
  };

  await f.controller.selectRepository('one');
  const before = f.sent.length;
  const pending = f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'delete-branch', refId: 'refs/heads/topic' },
    }),
  );

  t.onTestFinished(async () => {
    refreshed.resolve({ ...history, refs: page([]).refs });
    await pending;
    f.controller.dispose();
  });
  await refreshing.promise;
  expect(f.sent.slice(before).map((message) => message.body)).toContainEqual({
    kind: 'references',
    references: page([]).refs,
    repository: {
      id: 'one',
      label: 'one',
      rootUri: 'file:///fixture/one',
      branch: 'main',
      headSha: a,
    },
  });
  expect(
    f.sent.slice(before).map((message) => message.body.kind),
  ).not.toContain('history');
});

test('checkout metadata reaches the Log before the replacement graph', async (t) => {
  const f = fixture(true, true, { askBranchName: async () => 'new-branch' });
  const repositories = f.adapter.repositories();
  const refreshed = deferred<typeof history>();
  const refreshing = deferred<void>();
  let checkedOut = false;
  let reads = 0;

  f.adapter.repositories = () =>
    repositories.map((repo) => ({
      ...repo,
      branch: checkedOut && repo.id === 'one' ? 'new-branch' : repo.branch,
    }));
  f.adapter.operate = async () => {
    checkedOut = true;

    return { kind: 'success', backend: 'api' };
  };

  f.adapter.history = async (_id, _input, _signal, onReferences) => {
    if (++reads === 1) return history;
    await onReferences?.([
      { ...history.refs[0]!, id: 'refs/heads/new-branch', name: 'new-branch' },
    ]);
    refreshing.resolve();

    return refreshed.promise;
  };

  await f.controller.selectRepository('one');
  const pending = f.controller.handle(
    f.request({
      kind: 'action',
      action: {
        kind: 'create-branch-checkout',
        refId: 'refs/heads/main',
      },
    }),
  );

  t.onTestFinished(async () => {
    refreshed.resolve(history);
    await pending;
    f.controller.dispose();
  });
  await refreshing.promise;
  expect(f.sent.map((message) => message.body)).toContainEqual({
    kind: 'references',
    references: [
      { ...history.refs[0]!, id: 'refs/heads/new-branch', name: 'new-branch' },
    ],
    repository: { ...repositories[0], branch: 'new-branch' },
  });
});

test('worktree results are refreshed without waiting for the replacement graph', async (t) => {
  const f = fixture();
  const refreshed = deferred<typeof history>();
  const refreshing = deferred<void>();
  let reads = 0;

  f.adapter.history = async () => {
    if (++reads === 1) return history;
    refreshing.resolve();

    return refreshed.promise;
  };

  await f.controller.selectRepository('one');
  const before = f.sent.length;
  const pending = f.controller.handle(
    f.request({ kind: 'action', action: { kind: 'fetch-all' } }),
  );

  t.onTestFinished(async () => {
    refreshed.resolve(history);
    await pending;
    f.controller.dispose();
  });
  await refreshing.promise;
  await expect
    .poll(() => f.sent.slice(before).map((message) => message.body.kind))
    .toContain('worktrees');
});

test('a repository event during refresh keeps progress and write ownership through the final graph', async (t) => {
  const f = fixture();
  const first = deferred<typeof history>();
  const final = deferred<typeof history>();
  const started = deferred<void>();
  const restarted = deferred<void>();
  let reads = 0;

  f.adapter.history = async () => {
    if (++reads === 1) return history;
    if (reads === 2) {
      started.resolve();

      return first.promise;
    }

    restarted.resolve();

    return final.promise;
  };

  await f.controller.selectRepository('one');
  const request = f.request({ kind: 'action', action: { kind: 'fetch-all' } });
  const pending = f.controller.handle(request);

  t.onTestFinished(async () => {
    first.resolve(history);
    final.resolve(history);
    await pending;
    f.controller.dispose();
  });
  await started.promise;
  f.fireHistoryEvent();
  first.resolve(history);
  await restarted.promise;
  expect(f.sent.at(-1)?.body).not.toEqual({
    kind: 'operation-progress',
    operation: null,
  });
  expect(f.sent.map((message) => message.body)).not.toContainEqual({
    kind: 'operation-progress',
    operation: null,
  });
  await f.controller.handle(request);
  expect(f.writes).toHaveLength(1);
  final.resolve(history);
  await pending;
  expect(f.sent.at(-1)?.body).toEqual({
    kind: 'operation-progress',
    operation: null,
  });
});

test('Restore waits for deletion refresh and owns progress until its own refresh settles', async (t) => {
  let restore: (() => Promise<void>) | undefined;
  const f = fixture(true, true, {
    reportBranchDeleted: (_name, action) => {
      restore = action;
    },
  });
  const deletion = deferred<typeof history>();
  const restored = deferred<typeof history>();
  const deleting = deferred<void>();
  const restoring = deferred<void>();
  let reads = 0;
  const writes: string[] = [];

  f.adapter.history = async () => {
    if (++reads === 1) return history;
    if (reads === 2) {
      deleting.resolve();

      return deletion.promise;
    }

    restoring.resolve();

    return restored.promise;
  };

  f.adapter.operate = async (_id, action) => {
    writes.push(action.kind);

    return action.kind === 'delete-branch'
      ? {
          kind: 'success',
          backend: 'api',
          branchRestore: { name: 'topic', token: 'deleted-topic' },
        }
      : { kind: 'success', backend: 'api' };
  };

  await f.controller.selectRepository('one');
  const pending = f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'delete-branch', refId: 'refs/heads/topic' },
    }),
  );
  const undos: Promise<void>[] = [];

  t.onTestFinished(async () => {
    deletion.resolve(history);
    restored.resolve(history);
    await Promise.allSettled([pending, ...undos]);
    f.controller.dispose();
  });
  await deleting.promise;
  assert.ok(restore);
  const undo = restore();
  const duplicate = restore();

  undos.push(undo, duplicate);
  expect(writes).toEqual(['delete-branch']);
  deletion.resolve(history);
  await restoring.promise;
  expect(writes).toEqual(['delete-branch', 'restore-branch']);
  expect(f.sent.map((message) => message.body)).toContainEqual({
    kind: 'operation-progress',
    operation: {
      label: 'Restoring topic…',
      refIds: ['refs/heads/topic'],
      phase: 'running',
    },
  });
  expect(f.sent.at(-1)?.body).not.toEqual({
    kind: 'operation-progress',
    operation: null,
  });
  restored.resolve(history);
  await Promise.all([pending, undo, duplicate]);
  expect(f.sent.at(-1)?.body).toEqual({
    kind: 'operation-progress',
    operation: null,
  });
});
