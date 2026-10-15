import { expect, test } from 'vitest';

import type { WorktreeInfo } from '../../src/shared/model';
import { a, fixture, page } from '../fixtures/controller';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

test('refresh shows history activity before checking the selected reference', async (t) => {
  const f = fixture();
  const refs = deferred<ReturnType<typeof page>['refs']>();
  const entered = deferred<void>();

  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({
      kind: 'history',
      scope: { kind: 'ref', refId: 'refs/heads/main' },
      text: '',
      cursor: null,
    }),
  );
  f.adapter.references = async () => {
    entered.resolve();

    return refs.promise;
  };

  const before = f.sent.length;
  const pending = f.controller.refresh();

  t.onTestFinished(async () => {
    refs.resolve(page([a]).refs);
    await pending;
    f.controller.dispose();
  });
  await entered.promise;
  expect(
    f.sent.slice(before).some((message) => message.body.kind === 'loading'),
  ).toBe(true);
});

test('Worktrees reports its own read activity and ignores an older concurrent result', async (t) => {
  const f = fixture();
  const first = deferred<WorktreeInfo[]>();
  const second = deferred<WorktreeInfo[]>();
  const started = deferred<void>();
  const firstStarted = deferred<void>();
  let reads = 0;

  await f.controller.selectRepository('one');
  f.adapter.worktrees = async () => {
    if (++reads === 2) started.resolve();
    else firstStarted.resolve();

    return reads === 1 ? first.promise : second.promise;
  };

  const before = f.sent.length;
  const older = f.controller.handle(f.request({ kind: 'worktrees' }));

  await firstStarted.promise;
  const newer = f.controller.handle({
    ...f.request({ kind: 'worktrees' }),
    requestId: 'newer',
  });

  t.onTestFinished(async () => {
    first.resolve([]);
    second.resolve([]);
    await Promise.allSettled([older, newer]);
    f.controller.dispose();
  });
  await started.promise;
  expect(f.sent.slice(before).map((message) => message.body)).toContainEqual({
    kind: 'worktrees-loading',
    loading: true,
  });
  const worktree = (id: string): WorktreeInfo => ({
    id,
    name: id,
    rootUri: `file:///${id}`,
    branch: 'main',
    current: false,
    available: true,
  });

  second.resolve([worktree('newer')]);
  await newer;
  first.resolve([worktree('older')]);
  await older;
  expect(
    f.sent.flatMap((message) =>
      message.body.kind === 'worktrees'
        ? message.body.worktrees.map((item) => item.id)
        : [],
    ),
  ).toEqual(['newer']);
  expect(f.sent.at(-1)?.body).toEqual({
    kind: 'worktrees-loading',
    loading: false,
  });
});

test('a failed Worktrees read clears its activity', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  f.adapter.worktrees = async () => {
    throw new Error('Unavailable');
  };

  await f.controller.handle(f.request({ kind: 'worktrees' }));
  expect(f.sent.at(-1)?.body).toEqual({
    kind: 'worktrees-loading',
    loading: false,
  });
});
