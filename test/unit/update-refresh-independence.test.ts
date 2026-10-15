import { expect, test, vi } from 'vitest';

import type { GitAction, OperationResult } from '../../src/shared/model';
import { a, b, fixture, page } from '../fixtures/controller';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

const history = {
  ...page([a]),
  refs: ['main', 'first', 'second'].map((name) => ({
    ...page([]).refs[0]!,
    id: `refs/heads/${name}`,
    name,
    tracking: { upstream: `refs/remotes/origin/${name}`, ahead: 0, behind: 2 },
  })),
};
const update = (name: string) => ({
  kind: 'action' as const,
  action: { kind: 'update-branch' as const, refId: `refs/heads/${name}` },
});

for (const slowRead of ['history', 'worktrees'] as const)
  test(`another accepted branch update starts while the previous ${slowRead} refresh is pending`, async (t) => {
    const f = fixture();
    const network = deferred<OperationResult>();
    const writeStarted = deferred<void>();
    const readStarted = deferred<void>();
    const gate = deferred<void>();
    const writes: GitAction[] = [];
    let reads = 0;

    f.adapter.history = async () => {
      if (++reads === 2 && slowRead === 'history') {
        readStarted.resolve();
        await gate.promise;
      }

      return history;
    };

    f.adapter.operate = async (_id, action) => {
      writes.push(action);
      if (writes.length === 1) {
        writeStarted.resolve();

        return network.promise;
      }

      return { kind: 'success', backend: 'api' };
    };

    await f.controller.selectRepository('one');
    if (slowRead === 'worktrees')
      f.adapter.worktrees = async () => {
        readStarted.resolve();
        await gate.promise;

        return [];
      };

    const pending = [f.controller.handle(f.request(update('first')))];

    t.onTestFinished(async () => {
      network.resolve({ kind: 'success', backend: 'api' });
      gate.resolve();
      await Promise.allSettled(pending);
      f.controller.dispose();
    });
    await writeStarted.promise;
    pending.push(f.controller.handle(f.request(update('second'))));
    await f.controller.handle(f.request(update('second')));
    network.resolve({ kind: 'success', backend: 'api' });
    await readStarted.promise;
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({
      kind: 'update-branch',
      refId: 'refs/heads/second',
      expectedSha: a,
      expectedUpstream: 'refs/remotes/origin/second',
    });
  });

test('a superseded first refresh cannot publish stale history or clear the second update spinner', async (t) => {
  const f = fixture();
  const firstRead = deferred<typeof history>();
  const secondWrite = deferred<OperationResult>();
  const readStarted = deferred<void>();
  const secondStarted = deferred<void>();
  let reads = 0;
  let writes = 0;

  f.adapter.history = async (_id, _input, _signal, onReferences) => {
    await onReferences?.(history.refs);
    if (++reads === 2) {
      readStarted.resolve();

      return firstRead.promise;
    }

    return history;
  };

  f.adapter.operate = async () => {
    if (++writes === 2) {
      secondStarted.resolve();

      return secondWrite.promise;
    }

    return { kind: 'success', backend: 'api' };
  };

  await f.controller.selectRepository('one');
  const first = f.controller.handle(f.request(update('first')));
  const pending = [first];

  t.onTestFinished(async () => {
    firstRead.resolve(history);
    secondWrite.resolve({ kind: 'success', backend: 'api' });
    await Promise.allSettled(pending);
    f.controller.dispose();
  });
  await readStarted.promise;
  // Fresh references are actionable before the slow graph read finishes.
  pending.push(f.controller.handle(f.request(update('second'), 'one', 2)));
  await vi.waitFor(() => expect(writes).toBe(2));
  await secondStarted.promise;
  expect(
    f.sent.some((message) => message.body.kind === 'history-interrupted'),
  ).toBe(true);
  const before = f.sent.length;

  firstRead.resolve({ ...history, commits: page([b]).commits });
  await first;
  expect(
    f.sent.slice(before).some((message) => message.body.kind === 'history'),
  ).toBe(false);
  expect(
    f.sent
      .filter((message) => message.body.kind === 'operation-progress')
      .at(-1)?.body,
  ).toMatchObject({
    kind: 'operation-progress',
    operation: { phase: 'running', refIds: ['refs/heads/second'] },
  });
});

test('a superseded Worktrees read cannot keep automatic history refresh paused', async (t) => {
  const f = fixture();
  const stale = deferred<void>();
  const readStarted = deferred<void>();
  let histories = 0;
  let worktrees = 0;

  f.adapter.history = async (_id, _input, _signal, onReferences) => {
    histories++;
    await onReferences?.(history.refs);

    return history;
  };

  await f.controller.selectRepository('one');
  f.adapter.worktrees = async () => {
    if (++worktrees === 1) {
      readStarted.resolve();
      await stale.promise;
    }

    return [];
  };

  const first = f.controller.handle(f.request(update('first')));
  const pending = [first];

  t.onTestFinished(async () => {
    stale.resolve();
    await Promise.allSettled(pending);
    f.controller.dispose();
  });
  await readStarted.promise;
  const second = f.controller.handle(f.request(update('second'), 'one', 2));

  pending.push(second);
  await second;
  const before = histories;

  f.fireHistoryEvent();
  await vi.waitFor(() => expect(histories).toBeGreaterThan(before));
});

test('a newer Worktrees request releases the obsolete automatic read before the next ordinary action', async (t) => {
  const f = fixture(true, true, { askBranchName: async () => 'created' });
  const stale = deferred<void>();
  const readStarted = deferred<void>();
  const writes: GitAction[] = [];
  let reads = 0;

  await f.controller.selectRepository('one');
  f.adapter.worktrees = async () => {
    if (++reads === 1) {
      readStarted.resolve();
      await stale.promise;
    }

    return [];
  };

  f.adapter.operate = async (_id, action) => {
    writes.push(action);

    return { kind: 'success', backend: 'api' };
  };

  const pending = [
    f.controller.handle(
      f.request({ kind: 'action', action: { kind: 'fetch-all' } }),
    ),
  ];

  t.onTestFinished(async () => {
    stale.resolve();
    await Promise.allSettled(pending);
    f.controller.dispose();
  });
  await readStarted.promise;
  await f.controller.handle(f.request({ kind: 'worktrees' }, 'one', 2));
  pending.push(
    f.controller.handle(
      f.request(
        {
          kind: 'action',
          action: { kind: 'create-branch', refId: 'refs/heads/main' },
        },
        'one',
        2,
      ),
    ),
  );
  await vi.waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toMatchObject({ kind: 'create-branch', name: 'created' });
  await Promise.all(pending);
});
