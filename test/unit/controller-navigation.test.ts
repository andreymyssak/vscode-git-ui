import { assert, expect, onTestFinished, test } from 'vitest';

import type { PanelBody, Result } from '../../src/shared/messages';
import { a, b, fixture, page } from '../fixtures/controller';

test('a later branch navigation keeps the selected commit when an older resolution completes last', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });

  let entered!: () => void;
  const resolving = new Promise<void>((resolve) => {
    entered = resolve;
  });

  f.adapter.resolve = async (_id, input) => {
    if (input === 'refs/heads/older') {
      entered();
      await delayed;
    }

    return {
      kind: 'commit',
      commit: page([input === 'refs/heads/older' ? a : b]).commits[0]!,
    };
  };

  await f.controller.selectRepository('one');
  f.sent.length = 0;
  const older = f.controller.handle(
    f.request({ kind: 'go-to', input: 'refs/heads/older' }),
  );

  t.onTestFinished(async () => {
    release();
    await older;
  });
  await resolving;
  await f.controller.handle(
    f.request({ kind: 'go-to', input: 'refs/heads/newer' }),
  );
  release();
  await older;
  expect(
    f.sent
      .filter((message) => message.body.kind === 'reveal')
      .map((message) => message.body),
  ).toStrictEqual([{ kind: 'reveal', sha: b }]);
  expect(f.writes.length).toBe(0);
});

test('a later navigation retains selection when an older history publication finishes last', async (t) => {
  const sent: Result<PanelBody>[] = [];
  let release!: () => void;
  let entered!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publishing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const c = 'c'.repeat(40);
  const f = fixture(true, true, {
    send: async (message) => {
      sent.push(message);
      if (message.requestId === 'older' && message.body.kind === 'history') {
        entered();
        await delayed;
      }
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  f.adapter.resolve = async (_id, input) => ({
    kind: 'commit',
    commit: page([input === 'older' ? c : b]).commits[0]!,
  });
  f.adapter.history = async () => page([a, b, c]);
  sent.length = 0;
  const older = f.controller.handle({
    ...f.request({ kind: 'go-to', input: 'older' }),
    requestId: 'older',
  });

  t.onTestFinished(async () => {
    release();
    await older;
  });
  await publishing;
  await f.controller.handle(f.request({ kind: 'go-to', input: 'newer' }));
  release();
  await older;
  expect(
    sent
      .filter((message) => message.body.kind === 'reveal')
      .map((message) => message.body),
  ).toStrictEqual([{ kind: 'reveal', sha: b }]);
  expect(f.writes.length).toBe(0);
});

test('an older failed navigation stays quiet while a current failure is reported', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  let reject!: (error: Error) => void;
  const delayed = new Promise<never>((_resolve, rejectFailure) => {
    reject = rejectFailure;
  });

  let entered!: () => void;
  const resolving = new Promise<void>((resolve) => {
    entered = resolve;
  });

  f.adapter.resolve = async (_id, input) => {
    if (input === 'older') {
      entered();

      return delayed;
    }

    if (input === 'current-error')
      throw new Error('Current reference read failed');

    return { kind: 'commit', commit: page([b]).commits[0]! };
  };

  await f.controller.selectRepository('one');
  f.sent.length = 0;
  const older = f.controller.handle(
    f.request({ kind: 'go-to', input: 'older' }),
  );

  t.onTestFinished(async () => {
    reject(new Error('Fixture closed'));
    await older;
  });
  await resolving;
  await f.controller.handle(f.request({ kind: 'go-to', input: 'newer' }));
  reject(new Error('Old reference read failed'));
  await older;
  expect(f.sent.filter((message) => message.body.kind === 'error').length).toBe(
    0,
  );
  await f.controller.handle(
    f.request({ kind: 'go-to', input: 'current-error' }),
  );
  expect(
    f.sent
      .filter((message) => message.body.kind === 'error')
      .map((message) => message.body),
  ).toStrictEqual([
    { kind: 'error', message: 'Current reference read failed' },
  ]);
  expect(f.writes.length).toBe(0);
});

test('declining navigation retains the query, selected file and scroll anchor through refresh', async (t) => {
  const outside = 'c'.repeat(40);
  const f = fixture(true, true, {
    offerNavigation: async (decision) => {
      expect(decision.kind).toBe('offer-clear');

      return false;
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async (_id, input) =>
    input.scope.kind === 'all' ? page([outside]) : page([a, b]);
  f.adapter.resolve = async () => ({
    kind: 'commit',
    commit: page([outside]).commits[0]!,
  });
  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({
      kind: 'history',
      scope: { kind: 'head' },
      text: 'needle',
      cursor: null,
    }),
  );
  await f.controller.handle(
    f.request({ kind: 'select-commit', sha: b }, 'one', 2),
  );
  await f.controller.handle(
    f.request(
      { kind: 'open-file', fileId: `one-${b}`, preview: true },
      'one',
      2,
    ),
  );
  await f.controller.handle(
    f.request({ kind: 'anchor', anchor: { sha: b, offset: 9 } }, 'one', 2),
  );
  f.sent.length = 0;
  await f.controller.handle(
    f.request({ kind: 'go-to', input: outside }, 'one', 2),
  );
  expect(f.sent.length).toBe(0);
  await f.controller.refresh();
  const history = f.sent
    .filter((message) => message.body.kind === 'history')
    .at(-1)?.body;

  assert.ok(history?.kind === 'history');
  expect(history.text).toBe('needle');
  expect(history.scope).toStrictEqual({ kind: 'head' });
  const selection = f.sent
    .filter((message) => message.body.kind === 'selection')
    .at(-1)?.body;

  expect(selection).toStrictEqual({
    kind: 'selection',
    sha: b,
    parentSha: null,
    filePath: 'safe.txt',
    anchor: { sha: b, offset: 9 },
  });
  expect(f.writes).toStrictEqual([]);
  f.controller.dispose();
});

test('a host commit jump selects its source repository and publishes changed files without writes', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.resolve = async () => ({
    kind: 'commit',
    commit: page([b]).commits[0]!,
  });
  await f.controller.selectRepository('one');
  f.sent.length = 0;
  await f.controller.revealCommit({ repositoryId: 'two', sha: b });
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toMatchObject([
    { repositoryId: 'two', body: { sha: b } },
  ]);
  expect(f.sent.filter(({ body }) => body.kind === 'details')).toMatchObject([
    { repositoryId: 'two', body: { commit: { sha: b } } },
  ]);
  expect(f.sent.find(({ body }) => body.kind === 'files')).toMatchObject({
    repositoryId: 'two',
    body: { sha: b, files: [{ id: `two-${b}` }] },
  });
  expect(f.writes).toEqual([]);
});

test('a host commit jump finds a later page and preserves its query', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.resolve = async () => ({
    kind: 'commit',
    commit: page([b]).commits[0]!,
  });
  f.adapter.history = async (_id, input) =>
    input.cursor === 'later'
      ? page([b])
      : { ...page([a]), nextCursor: 'later' };
  await f.controller.selectRepository('one');
  f.sent.length = 0;
  await f.controller.revealCommit({ repositoryId: 'one', sha: b });
  expect(f.sent.find(({ body }) => body.kind === 'reveal')?.body).toEqual({
    kind: 'reveal',
    sha: b,
  });
  expect(
    f.sent.filter(({ body }) => body.kind === 'history').at(-1)?.body,
  ).toMatchObject({
    scope: { kind: 'head' },
    text: '',
    page: { commits: [{ sha: a }, { sha: b }] },
  });
});

test.each([false, true])(
  'host navigation automatically widens excluded history; unreachable=%s',
  async (unreachable) => {
    const f = fixture(true, true, {
      offerNavigation: async () =>
        assert.fail('Host navigation must not ask to clear filters'),
    });

    onTestFinished(() => f.controller.dispose());
    f.adapter.resolve = async () => ({
      kind: 'commit',
      commit: page([b]).commits[0]!,
    });
    f.adapter.history = async (_id, input) =>
      input.scope.kind === 'commit' ||
      (!unreachable && input.scope.kind === 'all')
        ? page([a, b])
        : page([a]);
    await f.controller.selectRepository('one');
    await f.controller.handle(
      f.request({
        kind: 'history',
        scope: { kind: 'head' },
        text: 'excluded',
        cursor: null,
        filters: {
          regex: false,
          matchCase: false,
          author: {
            kind: 'selected',
            identities: [{ name: 'Other', email: 'other@example.test' }],
          },
          date: '24h',
        },
      }),
    );
    f.sent.length = 0;
    await f.controller.revealCommit({ repositoryId: 'one', sha: b });
    expect(
      f.sent.filter(({ body }) => body.kind === 'loading').at(-1)?.body,
    ).toMatchObject({
      scope: unreachable ? { kind: 'commit', sha: b } : { kind: 'all' },
      text: '',
      filters: { author: { kind: 'all' }, date: 'all' },
    });
    expect(f.sent.find(({ body }) => body.kind === 'reveal')?.body).toEqual({
      kind: 'reveal',
      sha: b,
    });
  },
);

test('a subsequent user selection cancels a slow host jump', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  let release = () => {};

  let enter = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });

  f.adapter.resolve = async () => {
    enter();
    await gate;

    return { kind: 'commit', commit: page([b]).commits[0]! };
  };

  await f.controller.selectRepository('one');
  f.sent.length = 0;
  const pending = f.controller.revealCommit({ repositoryId: 'one', sha: b });

  await started;
  await f.controller.handle(
    f.request({ kind: 'select-commit', sha: a }, 'one', 2),
  );
  release();
  await pending;
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
  expect(
    f.sent.filter(({ body }) => body.kind === 'details').at(-1)?.body,
  ).toMatchObject({ commit: { sha: a } });
});

test('a recreated Log restores its saved selection after a completed host jump', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async () => page([a, b]);
  f.adapter.resolve = async () => ({
    kind: 'commit',
    commit: page([b]).commits[0]!,
  });
  await f.controller.selectRepository('one');
  await f.controller.revealCommit({ repositoryId: 'one', sha: b });
  f.sent.length = 0;
  await f.controller.handle(
    f.request({ kind: 'ready', savedRepositoryId: 'one' }, '', 0),
  );
  const history = f.sent.find(({ body }) => body.kind === 'history');

  assert.ok(history, 'a recreated webview must receive its history');
  await f.controller.handle(
    f.request(
      {
        kind: 'restore',
        scope: { kind: 'head' },
        text: '',
        selection: { sha: b, parentSha: a, filePath: null },
        anchor: null,
      },
      'one',
      history.generation,
    ),
  );
  expect(
    f.sent.find(({ body }) => body.kind === 'selection')?.body,
  ).toMatchObject({
    kind: 'selection',
    sha: b,
  });
  expect(f.writes).toEqual([]);
});

test('late saved-state restoration cannot reset a host jump', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  let release = () => {};

  let enter = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });

  f.adapter.resolve = async () => {
    enter();
    await gate;

    return { kind: 'commit', commit: page([b]).commits[0]! };
  };

  await f.controller.selectRepository('one');
  f.sent.length = 0;
  const pending = f.controller.revealCommit({ repositoryId: 'one', sha: b });

  await started;
  await f.controller.handle(
    f.request(
      {
        kind: 'restore',
        scope: { kind: 'head' },
        text: 'old saved filter',
        selection: null,
        anchor: null,
      },
      'one',
      1,
    ),
  );
  release();
  await pending;
  expect(f.sent.filter(({ body }) => body.kind === 'error')).toEqual([]);
  expect(f.sent.find(({ body }) => body.kind === 'reveal')?.body).toEqual({
    kind: 'reveal',
    sha: b,
  });
});

test('the newest host target wins while another repository is still loading', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  let release = () => {};

  let enter = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });

  f.adapter.resolve = async (_id, sha) => ({
    kind: 'commit',
    commit: page([sha]).commits[0]!,
  });
  f.adapter.history = async (id) => {
    if (id === 'two') {
      enter();
      await gate;
    }

    return page([a, b]);
  };

  await f.controller.selectRepository('one');
  f.sent.length = 0;
  const older = f.controller.revealCommit({ repositoryId: 'two', sha: b });

  t.onTestFinished(async () => {
    release();
    await older;
  });
  await started;
  await f.controller.revealCommit({ repositoryId: 'one', sha: a });
  release();
  await older;
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toMatchObject([
    { repositoryId: 'one', body: { sha: a } },
  ]);
  expect(f.writes).toEqual([]);
});

test('a later user query cancels a slow host jump', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  let release = () => {};

  let enter = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });

  f.adapter.resolve = async () => {
    enter();
    await gate;

    return { kind: 'commit', commit: page([b]).commits[0]! };
  };

  await f.controller.selectRepository('one');
  f.sent.length = 0;
  const pending = f.controller.revealCommit({ repositoryId: 'one', sha: b });

  t.onTestFinished(async () => {
    release();
    await pending;
  });
  await started;
  await f.controller.handle(
    f.request(
      {
        kind: 'history',
        scope: { kind: 'all' },
        text: 'new query',
        cursor: null,
      },
      'one',
      2,
    ),
  );
  release();
  await pending;
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
  expect(
    f.sent.filter(({ body }) => body.kind === 'history').at(-1)?.body,
  ).toMatchObject({ scope: { kind: 'all' }, text: 'new query' });
});

for (const boundary of ['resolve', 'history', 'changes'] as const)
  test(`a source cancelled during ${boundary} cannot publish a late host jump`, async (t) => {
    const f = fixture();

    t.onTestFinished(() => f.controller.dispose());
    await f.controller.selectRepository('one');
    let current = true;
    let release = () => {};

    let enter = () => {};

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const hold = async () => {
      enter();
      await gate;
    };

    f.adapter.resolve = async () => {
      if (boundary === 'resolve') await hold();

      return { kind: 'commit', commit: page([b]).commits[0]! };
    };

    const history = f.adapter.history;
    const changes = f.adapter.changes;

    f.adapter.history = async (...args) => {
      if (boundary === 'history') await hold();

      return history(...args);
    };

    f.adapter.changes = async (...args) => {
      if (boundary === 'changes') await hold();

      return changes(...args);
    };

    const pending = f.controller.revealCommit(
      { repositoryId: 'one', sha: b },
      () => current,
    );

    t.onTestFinished(async () => {
      release();
      await pending;
    });
    await started;
    current = false;
    f.sent.length = 0;
    release();
    await pending;
    expect(f.sent).toEqual([]);
    expect(f.writes).toEqual([]);
  });
