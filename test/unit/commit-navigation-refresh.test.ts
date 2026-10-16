import { expect, test, type TestContext, vi } from 'vitest';

import type { RequestBody } from '../../src/shared/messages';
import { a, b, fixture, page } from '../fixtures/controller';

async function interruptedJump(
  t: TestContext,
  options: {
    holdResolve?: boolean;
    waitForRefresh?: boolean;
    sourceCurrent?: () => boolean;
  } = {},
) {
  const reports: string[] = [];
  const f = fixture(true, true, {
    reportActionError: async (message) => {
      reports.push(message);
    },
  });
  let enterResolve = () => {};

  let releaseResolve = () => {};

  let enterRefresh = () => {};

  let releaseRefresh = () => {};

  const resolving = new Promise<void>((resolve) => {
    enterResolve = resolve;
  });
  const resolveGate = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const refreshing = new Promise<void>((resolve) => {
    enterRefresh = resolve;
  });
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let resolutions = 0;
  let holdRefresh = true;
  let refreshError: Error | null = null;

  t.onTestFinished(() => {
    releaseResolve();
    releaseRefresh();
    f.controller.dispose();
  });
  await f.controller.selectRepository('one');
  f.sent.length = 0;
  f.adapter.resolve = async (_id, input, signal) => {
    resolutions++;
    if (resolutions === 1) {
      enterResolve();
      await resolveGate;
      signal?.throwIfAborted();
    }

    return { kind: 'commit', commit: page([input]).commits[0]! };
  };

  f.adapter.history = async () => {
    if (resolutions > 0 && holdRefresh) {
      holdRefresh = false;
      enterRefresh();
      await refreshGate;
      if (refreshError) throw refreshError;
    }

    return page([a, b]);
  };

  const pending = f.controller.revealCommit(
    { repositoryId: 'one', sha: b },
    options.sourceCurrent,
  );

  void pending.catch(() => {});
  await resolving;
  f.fireHistoryEvent();
  if (!options.holdResolve) releaseResolve();
  if (options.waitForRefresh !== false) await refreshing;

  return {
    ...f,
    reports,
    pending,
    releaseRefresh,
    releaseResolve,
    failRefresh(error: Error) {
      refreshError = error;
      releaseRefresh();
    },
    resolutions: () => resolutions,
  };
}

test('a current immutable host target resumes after the normal observation refresh', async (t) => {
  const f = await interruptedJump(t);

  expect(f.resolutions()).toBe(1);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
  f.releaseRefresh();
  await f.pending;
  expect(f.resolutions()).toBe(2);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toMatchObject([
    { repositoryId: 'one', body: { sha: b } },
  ]);
  expect(f.sent.find(({ body }) => body.kind === 'files')?.body).toMatchObject({
    sha: b,
    files: [{ id: `one-${b}` }],
  });
  expect(f.writes).toEqual([]);
});

test('a user selection retires an immutable target waiting for observation refresh', async (t) => {
  const f = await interruptedJump(t);
  const generation = f.sent.at(-1)!.generation;

  await f.controller.handle(
    f.request({ kind: 'select-commit', sha: a }, 'one', generation),
  );
  f.releaseRefresh();
  await f.pending;
  expect(f.resolutions()).toBe(1);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
  expect(f.writes).toEqual([]);
});

test('disposal retires a host target waiting for observation refresh', async (t) => {
  const f = await interruptedJump(t);

  f.controller.dispose();
  await f.pending;
  f.releaseRefresh();
  expect(f.resolutions()).toBe(1);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
});

test('a refresh completed before the old target read settles still resumes that target', async (t) => {
  const f = await interruptedJump(t, { holdResolve: true });

  f.releaseRefresh();
  await vi.waitFor(() =>
    expect(f.sent.at(-1)?.body.kind).toBe('history-settled'),
  );
  expect(f.resolutions()).toBe(1);
  f.releaseResolve();
  await f.pending;
  expect(f.resolutions()).toBe(2);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toMatchObject([
    { body: { sha: b } },
  ]);
});

test('coalesced observations resume the target only after their latest refresh', async (t) => {
  const f = await interruptedJump(t);

  for (let index = 0; index < 3; index++) f.fireHistoryEvent();
  await f.pending;
  expect(f.resolutions()).toBe(2);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toMatchObject([
    { body: { sha: b } },
  ]);
  f.releaseRefresh();
});

test('a reported refresh failure retires its waiting target without another resolution', async (t) => {
  const f = await interruptedJump(t);

  f.failRefresh(new Error('Fresh metadata unavailable'));
  await expect(f.pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.resolutions()).toBe(1);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
  expect(f.reports).toEqual(['Fresh metadata unavailable']);
});

test('a reported refresh failure retires a target whose old read has not settled', async (t) => {
  const f = await interruptedJump(t, { holdResolve: true });

  f.failRefresh(new Error('Fresh metadata unavailable'));
  await vi.waitFor(() =>
    expect(f.sent.some(({ body }) => body.kind === 'error')).toBe(true),
  );
  f.releaseResolve();
  await expect(f.pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.resolutions()).toBe(1);
});

for (const action of ['scope', 'repository', 'hide'] as const)
  test(`${action} changes retire a target waiting for observation refresh`, async (t) => {
    const f = await interruptedJump(t);

    if (action === 'scope')
      await f.controller.handle(
        f.request(
          { kind: 'history', scope: { kind: 'all' }, text: '', cursor: null },
          'one',
          f.sent.at(-1)!.generation,
        ),
      );
    else if (action === 'repository')
      await f.controller.selectRepository('two');
    else await f.controller.setVisible(false);
    await f.pending;
    f.releaseRefresh();
    expect(f.resolutions()).toBe(1);
    expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
    expect(f.writes).toEqual([]);
  });

test('a newer host target retires an older target waiting for observation refresh', async (t) => {
  const f = await interruptedJump(t);

  await f.controller.revealCommit({ repositoryId: 'one', sha: a });
  await f.pending;
  f.releaseRefresh();
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toMatchObject([
    { body: { sha: a } },
  ]);
});

test('closing the source repository retires its waiting target', async (t) => {
  const f = await interruptedJump(t);
  const repositories = f.adapter.repositories();

  f.adapter.repositories = () =>
    repositories.filter((repo) => repo.id !== 'one');
  f.fireRepositoryEvent({ kind: 'closed', repositoryId: 'one' });
  await f.pending;
  f.releaseRefresh();
  expect(f.resolutions()).toBe(1);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
});

test('an expired source cannot resume its target after observation refresh', async (t) => {
  let current = true;
  const f = await interruptedJump(t, { sourceCurrent: () => current });

  current = false;
  f.releaseRefresh();
  await f.pending;
  expect(f.resolutions()).toBe(1);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
});

test('normal refresh still reports a failure once after the waiting source expires', async (t) => {
  let current = true;
  const f = await interruptedJump(t, { sourceCurrent: () => current });

  current = false;
  f.failRefresh(new Error('Fresh metadata unavailable'));
  await f.pending;
  await vi.waitFor(() =>
    expect(f.reports).toEqual(['Fresh metadata unavailable']),
  );
  expect(f.resolutions()).toBe(1);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
});

test.for([
  { kind: 'select-commit', sha: a },
  { kind: 'go-to', input: a },
  { kind: 'open-file', fileId: `one-${a}`, preview: false },
  { kind: 'refresh' },
] satisfies RequestBody[])(
  'a $kind intent during the observation debounce retires the old host target',
  async (body, t) => {
    const f = await interruptedJump(t, { waitForRefresh: false });

    await f.controller.handle(
      f.request(body, 'one', f.sent.at(-1)!.generation),
    );
    f.releaseRefresh();
    await f.pending;
    expect(f.resolutions()).toBe(1);
    expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
    expect(f.writes).toEqual([]);
  },
);
