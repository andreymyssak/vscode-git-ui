import { afterEach, expect, test, type TestContext, vi } from 'vitest';

import { a, b, fixture, page } from '../fixtures/controller';

afterEach(() => vi.useRealTimers());

async function pendingObservation(
  t: TestContext,
  options: { established?: boolean } = {},
) {
  vi.useFakeTimers();
  const reports: string[] = [];
  const f = fixture(true, true, {
    reportActionError: async (message) => {
      reports.push(message);
    },
  });
  let resolutions = 0;

  f.adapter.resolve = async (_id, input, signal) => {
    resolutions++;
    signal?.throwIfAborted();

    return { kind: 'commit', commit: page([input]).commits[0]! };
  };

  await f.controller.selectRepository('one');
  if (options.established !== false)
    await f.controller.revealCommit({ repositoryId: 'one', sha: a });
  const generation = f.sent.at(-1)!.generation;

  f.sent.length = 0;
  resolutions = 0;
  let enter = () => {};

  let release = () => {};

  let failure: Error | null = null;
  let refreshing = false;
  let historyReads = 0;
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  f.adapter.history = async (id) => {
    historyReads++;
    if (id === 'one' && !refreshing) {
      refreshing = true;
      enter();
      await gate;
      if (failure) throw failure;
    }

    return page([a, b]);
  };

  t.onTestFinished(() => {
    release();
    f.controller.dispose();
  });
  f.fireHistoryEvent();

  return {
    ...f,
    reports,
    generation,
    started,
    release,
    resolutions: () => resolutions,
    historyReads: () => historyReads,
    begin(sha = b, id = 'one', current = () => true) {
      const pending = f.controller.revealCommit(
        { repositoryId: id, sha },
        current,
      );

      void pending.catch(() => {});

      return pending;
    },
    fail(error: Error) {
      failure = error;
      release();
    },
  };
}

test('a new target joins an observation refresh that had no active host jump', async (t) => {
  const f = await pendingObservation(t);
  const pending = f.begin();

  await vi.advanceTimersByTimeAsync(50);
  await f.started;
  expect(f.resolutions()).toBe(0);
  f.release();
  await pending;
  expect(f.resolutions()).toBe(1);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toMatchObject([
    { repositoryId: 'one', body: { sha: b } },
  ]);
  expect(f.writes).toEqual([]);
});

test('pending observation ownership survives the timer handing off to refresh setup', async (t) => {
  const f = await pendingObservation(t);

  vi.advanceTimersByTime(50);
  const pending = f.begin();

  await f.started;
  expect(f.resolutions()).toBe(0);
  f.release();
  await pending;
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toMatchObject([
    { body: { sha: b } },
  ]);
});

test('a first host target reuses its completed observation refresh', async (t) => {
  const f = await pendingObservation(t, { established: false });
  const pending = f.begin();

  await vi.advanceTimersByTimeAsync(50);
  expect(f.resolutions()).toBe(0);
  f.release();
  await pending;
  expect(f.historyReads()).toBe(1);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toMatchObject([
    { body: { sha: b } },
  ]);
});

test('superseding a target does not consume pending observation ownership', async (t) => {
  const f = await pendingObservation(t);
  const older = f.begin(b);
  const newer = f.begin(a);

  await older;
  await vi.advanceTimersByTimeAsync(50);
  expect(f.resolutions()).toBe(0);
  f.release();
  await newer;
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toMatchObject([
    { body: { sha: a } },
  ]);
});

test('a target for another repository does not inherit the pending refresh', async (t) => {
  const f = await pendingObservation(t);

  await f.begin(b, 'two');
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toMatchObject([
    { repositoryId: 'two', body: { sha: b } },
  ]);
  expect(f.reports).toEqual([]);
});

test('observations coalesce before and after a new target joins the pending refresh', async (t) => {
  const f = await pendingObservation(t);

  f.fireHistoryEvent();
  const pending = f.begin();

  f.fireHistoryEvent();
  await vi.advanceTimersByTimeAsync(50);
  expect(f.resolutions()).toBe(0);
  f.release();
  await pending;
  expect(f.resolutions()).toBe(1);
});

test('a failed pending refresh retires a newly joined target and reports once', async (t) => {
  const f = await pendingObservation(t);
  const pending = f.begin();

  await vi.advanceTimersByTimeAsync(50);
  f.fail(new Error('Fresh history unavailable'));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.reports).toEqual(['Fresh history unavailable']);
  expect(f.resolutions()).toBe(0);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
});

for (const action of ['selection', 'hide', 'dispose'] as const)
  test(`${action} retires a new target waiting for its preexisting observation refresh`, async (t) => {
    const f = await pendingObservation(t);
    const pending = f.begin();

    if (action === 'selection')
      await f.controller.handle(
        f.request({ kind: 'select-commit', sha: a }, 'one', f.generation),
      );
    else if (action === 'hide') await f.controller.setVisible(false);
    else f.controller.dispose();
    await pending;
    expect(f.resolutions()).toBe(0);
    expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
  });

test('an expired new target leaves the pending refresh failure with its normal reporter', async (t) => {
  const f = await pendingObservation(t);
  let current = true;
  const pending = f.begin(b, 'one', () => current);

  await vi.advanceTimersByTimeAsync(50);
  current = false;
  f.fail(new Error('Fresh history unavailable'));
  await pending;
  expect(f.reports).toEqual(['Fresh history unavailable']);
  expect(f.resolutions()).toBe(0);
});

test('a new target joins a normal action refresh before progress publication finishes', async (t) => {
  vi.useFakeTimers();
  const reveals: string[] = [];
  let generation = 0;
  let enter = () => {};

  let release = () => {};

  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(true, true, {
    send: async (message) => {
      generation = message.generation;
      if (message.body.kind === 'reveal') reveals.push(message.body.sha);
      if (
        message.body.kind === 'operation-progress' &&
        message.body.operation?.phase === 'refreshing'
      ) {
        enter();
        await gate;
      }
    },
  });

  f.adapter.resolve = async (_id, input, signal) => {
    signal?.throwIfAborted();

    return { kind: 'commit', commit: page([input]).commits[0]! };
  };

  await f.controller.selectRepository('one');
  await f.controller.revealCommit({ repositoryId: 'one', sha: a });
  reveals.length = 0;
  const action = f.controller.handle(
    f.request(
      { kind: 'action', action: { kind: 'fetch-all' } },
      'one',
      generation,
    ),
  );
  const pending = [action];

  t.onTestFinished(async () => {
    release();
    f.controller.dispose();
    await Promise.allSettled(pending);
  });
  await started;
  const target = f.controller.revealCommit({ repositoryId: 'one', sha: b });

  let completed = false;
  let failure: unknown = null;

  void target.then(
    () => {
      completed = true;
    },
    (error: unknown) => {
      failure = error;
    },
  );
  pending.push(target);
  await vi.advanceTimersByTimeAsync(0);
  expect(completed).toBe(false);
  expect(failure).toBeNull();
  expect(reveals).toEqual([]);
  release();
  await Promise.all(pending);
  expect(reveals).toEqual([b]);
  expect(f.writes).toHaveLength(1);
});
