import { expect, test, vi } from 'vitest';

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
    {
      id: 'refs/heads/main',
      name: 'main',
      kind: 'local' as const,
      sha: a,
      remote: null,
      tracking: { upstream: 'refs/remotes/origin/main', ahead: 0, behind: 1 },
    },
  ],
};
const update = {
  kind: 'action' as const,
  action: { kind: 'update-branch' as const, refId: 'refs/heads/main' },
};
const progress = (phase: 'running' | 'refreshing' | 'finished') => ({
  kind: 'operation-progress',
  operation:
    phase === 'finished'
      ? null
      : {
          label: 'Updating main…',
          refIds: ['refs/heads/main'],
          phase,
          section: 'branches',
        },
});

test('Update publishes progress before a slow Git operation and ignores repeated Update requests', async (t) => {
  const f = fixture();
  const network = deferred<OperationResult>();
  const started = deferred<void>();
  let writes = 0;

  f.adapter.history = async () => history;
  f.adapter.operate = async () => {
    writes++;
    started.resolve();

    return network.promise;
  };

  await f.controller.selectRepository('one');
  const pending = f.controller.handle(f.request(update));

  t.onTestFinished(async () => {
    network.resolve({ kind: 'success', backend: 'api' });
    await pending;
    f.controller.dispose();
  });
  await started.promise;
  expect(f.sent.map((message) => message.body)).toContainEqual(
    progress('running'),
  );
  let repeatedFinished = false;

  const repeated = f.controller.handle({
    ...f.request(update),
    requestId: 'repeat',
  });

  void repeated.then(() => {
    repeatedFinished = true;
  });
  await vi.waitFor(() => expect(repeatedFinished).toBe(true));
  expect(writes).toBe(1);
  expect(f.sent.map((message) => message.body)).not.toContainEqual(
    progress('finished'),
  );
  network.resolve({ kind: 'success', backend: 'api' });
  await pending;
  expect(f.sent.at(-1)?.body).toEqual(progress('finished'));
});

test('Update keeps progress through a slow history refresh and coalesces repository events', async (t) => {
  const reportActionError = vi.fn(async () => {});
  const f = fixture(true, true, { reportActionError });
  const refreshed = deferred<typeof history>();
  const refreshStarted = deferred<void>();
  const network = deferred<OperationResult>();
  const started = deferred<void>();
  let reads = 0;

  f.adapter.history = async () => {
    if (++reads === 1) return history;
    refreshStarted.resolve();

    return refreshed.promise;
  };

  f.adapter.operate = async () => {
    started.resolve();

    return network.promise;
  };

  await f.controller.selectRepository('one');
  const pending = f.controller.handle(f.request(update));

  t.onTestFinished(async () => {
    network.resolve({ kind: 'success', backend: 'api' });
    refreshed.resolve(history);
    await pending;
    f.controller.dispose();
  });
  await started.promise;
  f.fireHistoryEvent();
  network.resolve({ kind: 'success', backend: 'api' });
  await refreshStarted.promise;
  expect(f.sent.map((message) => message.body)).toContainEqual(
    progress('refreshing'),
  );
  expect(f.sent.map((message) => message.body)).not.toContainEqual(
    progress('finished'),
  );
  // A menu opened before the refresh still carries the earlier history generation.
  await f.controller.handle(f.request(update));
  expect(reportActionError).not.toHaveBeenCalled();
  refreshed.resolve(history);
  await pending;
  expect(f.sent.at(-1)?.body).toEqual(progress('finished'));
  expect(reads).toBe(2);
});

for (const outcome of [
  { kind: 'success', backend: 'api' },
  { kind: 'cancelled', backend: null },
  { kind: 'error', backend: 'api', message: 'Fetch failed' },
] satisfies OperationResult[])
  test(`Update clears progress after ${outcome.kind}`, async (t) => {
    const f = fixture();

    t.onTestFinished(() => f.controller.dispose());
    f.adapter.history = async () => history;
    f.adapter.operate = async () => outcome;
    await f.controller.selectRepository('one');
    await f.controller.handle(f.request(update));
    expect(f.sent.at(-1)?.body).toEqual(progress('finished'));
  });

test('an ineligible Update target reports an error without dispatching a Git write', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  await f.controller.handle(f.request(update));
  expect(f.writes).toEqual([]);
  expect(f.sent.map((message) => message.body)).toContainEqual({
    kind: 'error',
    message:
      'Select a local branch with an available tracked upstream before updating.',
  });
});

test('an active Update is republished when returning to its repository', async (t) => {
  const f = fixture();
  const network = deferred<OperationResult>();
  const started = deferred<void>();

  f.adapter.history = async () => history;
  f.adapter.operate = async () => {
    started.resolve();

    return network.promise;
  };

  await f.controller.selectRepository('one');
  const pending = f.controller.handle(f.request(update));

  t.onTestFinished(async () => {
    network.resolve({ kind: 'success', backend: 'api' });
    await pending;
    f.controller.dispose();
  });
  await started.promise;
  await f.controller.selectRepository('two');
  const before = f.sent.length;

  await f.controller.selectRepository('one');
  expect(f.sent.slice(before)).toContainEqual(
    expect.objectContaining({
      repositoryId: 'one',
      requestId: 'test',
      body: progress('running'),
    }),
  );
});

for (const change of ['repository', 'disposal', 'trust'] as const)
  test(`Update does not capture a target after ${change} changes during progress publication`, async (t) => {
    const delivered = deferred<void>();
    const release = deferred<void>();
    let trusted = true;
    const f = fixture(true, true, {
      trusted: () => trusted,
      send: async (message) => {
        if (
          message.body.kind === 'operation-progress' &&
          message.body.operation?.phase === 'running'
        ) {
          delivered.resolve();
          await release.promise;
        }
      },
    });

    f.adapter.history = async (id) => ({
      ...history,
      refs: history.refs.map((ref) => ({
        ...ref,
        sha: id === 'one' ? a : 'b'.repeat(40),
        tracking: { ...ref.tracking, upstream: `refs/remotes/origin/${id}` },
      })),
    });
    await f.controller.selectRepository('one');
    const pending = f.controller.handle(f.request(update));

    t.onTestFinished(async () => {
      release.resolve();
      await pending;
      f.controller.dispose();
    });
    await delivered.promise;
    if (change === 'repository') await f.controller.selectRepository('two');
    else if (change === 'disposal') f.controller.dispose();
    else trusted = false;
    release.resolve();
    await pending;
    expect(f.writes).toEqual([]);
  });
