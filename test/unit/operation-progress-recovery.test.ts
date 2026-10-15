import { assert, expect, test } from 'vitest';

import { a, fixture, page } from '../fixtures/controller';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  let reject: (error: Error) => void = () => {};

  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });

  return { promise, resolve, reject };
}

const history = {
  ...page([a]),
  refs: [
    ...page([]).refs,
    { ...page([]).refs[0]!, id: 'refs/heads/topic', name: 'topic' },
  ],
};

test('different Restore tokens from repeated native menu requests are both honored', async (t) => {
  const callbacks: (() => Promise<void>)[] = [];
  const f = fixture(true, true, {
    reportBranchDeleted: (_name, restore) => callbacks.push(restore),
  });
  const deletion = deferred<typeof history>();
  const restoring = deferred<typeof history>();
  const deleting = deferred<void>();
  const firstRestore = deferred<void>();
  const tokens: string[] = [];
  let deletions = 0;
  let reads = 0;

  f.adapter.operate = async (_id, action) => {
    if (action.kind === 'restore-branch') tokens.push(action.token);

    return action.kind === 'delete-branch'
      ? {
          kind: 'success',
          backend: 'api',
          branchRestore: { name: 'topic', token: `token-${++deletions}` },
        }
      : { kind: 'success', backend: 'api' };
  };

  f.adapter.history = async () => {
    if (++reads <= 2) return history;
    if (reads === 3) {
      deleting.resolve();

      return deletion.promise;
    }

    if (reads === 4) {
      firstRestore.resolve();

      return restoring.promise;
    }

    return history;
  };

  const pending: Promise<void>[] = [];

  t.onTestFinished(async () => {
    deletion.resolve(history);
    restoring.resolve(history);
    await Promise.allSettled(pending);
    f.controller.dispose();
  });
  await f.controller.selectRepository('one');
  const request = {
    ...f.request({
      kind: 'action',
      action: { kind: 'delete-branch', refId: 'refs/heads/topic' },
    }),
    requestId: 'branch-menu',
  };

  await f.controller.handle(request);
  pending.push(f.controller.handle({ ...request, generation: 2 }));
  await deleting.promise;
  assert.equal(callbacks.length, 2);
  pending.push(callbacks[0]!(), callbacks[1]!());
  deletion.resolve(history);
  await firstRestore.promise;
  expect(tokens).toEqual(['token-1', 'token-2']);
  restoring.resolve(history);
  await Promise.all(pending);
  expect(tokens).toEqual(['token-1', 'token-2']);
});

test('disposing the Log cancels a Restore queued behind its deletion refresh', async (t) => {
  let restore: (() => Promise<void>) | undefined;
  const f = fixture(true, true, {
    reportBranchDeleted: (_name, action) => {
      restore = action;
    },
  });
  const deletion = deferred<typeof history>();
  const deleting = deferred<void>();
  const writes: string[] = [];
  let reads = 0;

  f.adapter.history = async () => {
    if (++reads === 1) return history;
    deleting.resolve();

    return deletion.promise;
  };

  f.adapter.operate = async (_id, action) => {
    writes.push(action.kind);

    return {
      kind: 'success',
      backend: 'api',
      branchRestore: { name: 'topic', token: 'deleted' },
    };
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
    await Promise.allSettled([pending, ...undos]);
    f.controller.dispose();
  });
  await deleting.promise;
  assert.ok(restore);
  undos.push(restore());
  f.controller.dispose();
  deletion.resolve(history);
  await Promise.all([pending, ...undos]);
  expect(writes).toEqual(['delete-branch']);
});

test('a repository event supersedes an invalidated graph without reporting a false failure', async (t) => {
  const errors: string[] = [];
  const f = fixture(true, true, {
    reportActionError: async (message) => {
      errors.push(message);
    },
  });
  const first = deferred<typeof history>();
  const refreshing = deferred<void>();
  let reads = 0;

  f.adapter.history = async () => {
    if (++reads === 2) {
      refreshing.resolve();

      return first.promise;
    }

    return history;
  };

  await f.controller.selectRepository('one');
  const pending = f.controller.handle(
    f.request({ kind: 'action', action: { kind: 'fetch-all' } }),
  );

  t.onTestFinished(async () => {
    first.resolve(history);
    await pending;
    f.controller.dispose();
  });
  await refreshing.promise;
  f.fireHistoryEvent();
  first.reject(new Error('History changed. Refresh to load a new snapshot.'));
  await pending;
  expect(reads).toBe(3);
  expect(errors).toEqual([]);
  expect(f.sent.at(-1)?.body).toEqual({
    kind: 'operation-progress',
    operation: null,
  });
});

test('restoring a branch in an inactive repository cannot cancel the current repository read', async (t) => {
  let restore: (() => Promise<void>) | undefined;
  const f = fixture(true, true, {
    reportBranchDeleted: (_name, action) => {
      restore = action;
    },
  });
  const oldRead = deferred<typeof history>();
  const currentRead = deferred<typeof history>();
  const oldStarted = deferred<void>();
  const currentStarted = deferred<void>();
  let reads = 0;

  f.adapter.history = async (id) => {
    if (id === 'two') {
      currentStarted.resolve();

      return currentRead.promise;
    }

    if (++reads === 2) {
      oldStarted.resolve();

      return oldRead.promise;
    }

    return history;
  };

  f.adapter.operate = async (_id, action) =>
    action.kind === 'delete-branch'
      ? {
          kind: 'success',
          backend: 'api',
          branchRestore: { name: 'topic', token: 'restore-old' },
        }
      : { kind: 'success', backend: 'api' };
  await f.controller.selectRepository('one');
  const deletion = f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'delete-branch', refId: 'refs/heads/topic' },
    }),
  );

  await oldStarted.promise;
  const switching = f.controller.selectRepository('two');

  t.onTestFinished(async () => {
    oldRead.resolve(history);
    currentRead.resolve(history);
    await Promise.allSettled([deletion, switching]);
    f.controller.dispose();
  });
  await currentStarted.promise;
  assert.ok(restore);
  const before = f.sent.length;

  await restore();
  expect(
    f.sent.slice(before).filter((message) => message.repositoryId === 'two'),
  ).toEqual([]);
  currentRead.resolve(history);
  await switching;
  expect(
    f.sent.some(
      (message) =>
        message.repositoryId === 'two' && message.body.kind === 'history',
    ),
  ).toBe(true);
});
