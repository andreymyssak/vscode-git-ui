import { assert, expect, test } from 'vitest';

import type {
  AuthorIdentity,
  HistoryFilters,
  HistoryInput,
} from '../../src/shared/model';
import { a, fixture, page } from '../fixtures/controller';

const bob = { name: 'Bob', email: 'bob@example.test' };
const filters: HistoryFilters = {
  regex: true,
  matchCase: true,
  author: { kind: 'selected', identities: [bob] },
  date: '7d',
};

test('explicit refresh invalidates repository history before reading a new snapshot', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  const calls: string[] = [];

  f.adapter.history = async () => {
    calls.push('history');

    return page([a]);
  };

  f.adapter.invalidateHistory = (id) => {
    calls.push(`invalidate:${id}`);
  };

  await f.controller.selectRepository('one');
  calls.length = 0;
  await f.controller.refresh();
  expect(calls).toStrictEqual(['invalidate:one', 'history']);
  f.controller.dispose();
});
test('changes to other open repositories update the chooser without revoking current history or selection', async (t) => {
  let published!: () => void;
  const updated = new Promise<void>((resolve) => {
    published = resolve;
  });
  const f = fixture(true, true, {
    send: async (message) => {
      f.sent.push(message);
      if (
        message.body.kind === 'setup' &&
        message.body.repositories.length === 1
      )
        published();
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  const target = 'b'.repeat(40);
  let reads = 0;
  let invalidations = 0;

  f.adapter.history = async () => {
    reads++;

    return { ...page([a, target]), nextCursor: 'second' };
  };

  f.adapter.invalidateHistory = () => {
    invalidations++;
  };

  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'select-commit', sha: target }));
  const repositories = f.adapter.repositories();

  f.adapter.repositories = () => repositories.slice(0, 1);
  f.fireRepositoryEvent();
  await updated;
  expect(reads).toBe(1);
  expect(invalidations).toBe(0);
  const setup = f.sent.filter(({ body }) => body.kind === 'setup').at(-1)!;

  expect(setup.generation).toBe(1);
  assert.ok(setup.body.kind === 'setup');
  expect(setup.body.repositories.map(({ id }) => id)).toStrictEqual(['one']);
  await f.controller.handle(
    f.request({
      kind: 'history',
      scope: { kind: 'head' },
      text: '',
      cursor: 'second',
    }),
  );
  expect(reads).toBe(2);
  assert.ok(f.sent.some(({ body }) => body.kind === 'history' && body.append));
  await f.controller.refresh();
  const selection = f.sent
    .filter(({ body }) => body.kind === 'selection')
    .at(-1)?.body;

  assert.ok(selection?.kind === 'selection');
  expect(selection.sha).toBe(target);
  f.controller.dispose();
});
test('a refresh interrupted by another repository event retains its selection and scroll restoration target', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  const target = 'b'.repeat(40);

  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'select-commit', sha: target }));
  await f.controller.handle(
    f.request({ kind: 'anchor', anchor: { sha: target, offset: 5 } }),
  );
  let interrupted = true;

  f.adapter.history = async (_id, input) => {
    if (interrupted) {
      interrupted = false;
      throw new Error('History changed. Refresh to load a new snapshot.');
    }

    return input.cursor
      ? page([target])
      : { ...page([a]), nextCursor: 'second' };
  };

  await f.controller.refresh();
  await f.controller.refresh();
  const selection = f.sent
    .filter((message) => message.body.kind === 'selection')
    .at(-1)?.body;

  expect(selection?.kind).toBe('selection');
  if (selection?.kind === 'selection') {
    expect(selection.sha).toBe(target);
    expect(selection.anchor).toStrictEqual({ sha: target, offset: 5 });
  }

  f.controller.dispose();
});
test('overlapping refreshes restore the target once and ignore the superseded read', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  const target = 'b'.repeat(40);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'select-commit', sha: target }));
  await f.controller.handle(
    f.request({ kind: 'anchor', anchor: { sha: target, offset: 5 } }),
  );
  let reads = 0;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });

  f.adapter.history = async (_id, input) => {
    if (++reads === 1) {
      entered();
      await gate;
    }

    return input.cursor
      ? page([target])
      : { ...page([a]), nextCursor: 'second' };
  };

  const older = f.controller.refresh();

  t.onTestFinished(async () => {
    release();
    await older;
  });
  await ready;
  await f.controller.refresh();
  const count = f.sent.length;

  release();
  await older;
  expect(f.sent.length).toBe(count);
  const selection = f.sent
    .filter(({ body }) => body.kind === 'selection')
    .at(-1)?.body;

  assert.ok(selection?.kind === 'selection');
  expect(selection.sha).toBe(target);
  expect(selection.anchor).toStrictEqual({ sha: target, offset: 5 });
  f.controller.dispose();
});
test('an explicit cleared scroll anchor supersedes a failed refresh restoration target', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  const target = 'b'.repeat(40);

  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'select-commit', sha: target }));
  await f.controller.handle(
    f.request({ kind: 'anchor', anchor: { sha: target, offset: 5 } }),
  );
  f.adapter.history = async (_id, input) => {
    if (input.cursor) throw new Error('History changed');

    return { ...page([a]), nextCursor: 'second' };
  };

  await f.controller.refresh();
  await f.controller.handle(
    f.request({ kind: 'anchor', anchor: null }, 'one', 2),
  );
  f.adapter.history = async () => page([a, target]);
  await f.controller.refresh();
  const selection = f.sent
    .filter(({ body }) => body.kind === 'selection')
    .at(-1)?.body;

  assert.ok(selection?.kind === 'selection');
  expect(selection.sha).toBe(target);
  expect(selection.anchor).toBe(null);
  f.controller.dispose();
});
test('a fresh filter replaces a failed refresh restoration target', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  const target = 'b'.repeat(40);

  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'select-commit', sha: target }));
  f.adapter.history = async () => {
    throw new Error('History changed');
  };

  await f.controller.refresh();
  f.adapter.history = async () => page([a, target]);
  await f.controller.handle(
    f.request(
      { kind: 'history', scope: { kind: 'head' }, text: 'new', cursor: null },
      'one',
      2,
    ),
  );
  await f.controller.refresh();
  const selection = f.sent
    .filter(({ body }) => body.kind === 'selection')
    .at(-1)?.body;

  assert.ok(selection?.kind === 'selection');
  expect(selection.sha).toBe(null);
  f.controller.dispose();
});
test('initial repository history accepts the published default filters on its automatic next-page request', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  const reads: HistoryInput[] = [];

  f.adapter.history = async (_id, input) => {
    reads.push(input);

    return { ...page([a]), nextCursor: input.cursor ? null : 'page-two' };
  };

  await f.controller.handle(
    f.request({ kind: 'ready', savedRepositoryId: null }, '', 0),
  );
  const published = f.sent
    .filter(({ body }) => body.kind === 'history')
    .at(-1)!;

  expect(published.body.kind).toBe('history');
  if (published.body.kind !== 'history') return;
  assert.ok(published.body.filters);
  await f.controller.handle(
    f.request(
      {
        kind: 'history',
        scope: published.body.scope,
        text: published.body.text,
        filters: published.body.filters,
        cursor: published.body.page.nextCursor,
      },
      published.repositoryId,
      published.generation,
    ),
  );
  expect(reads.length).toBe(2);
  expect(reads[1]!.cursor).toBe('page-two');
  assert.ok(f.sent.some(({ body }) => body.kind === 'history' && body.append));
  f.controller.dispose();
});
test('a query replaced while loading is published cannot read the replacement input again', async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(true, true, {
    send: async (message) => {
      if (message.body.kind === 'loading' && message.body.text === 'old') {
        entered();
        await gate;
      }
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  const reads: string[] = [];

  f.adapter.history = async (_id, input) => {
    reads.push(input.text);

    return page([a]);
  };

  await f.controller.selectRepository('one');
  reads.length = 0;
  const old = f.controller.handle(
    f.request({
      kind: 'history',
      scope: { kind: 'head' },
      text: 'old',
      cursor: null,
    }),
  );

  t.onTestFinished(async () => {
    release();
    await old;
  });
  await waiting;
  await f.controller.handle(
    f.request(
      { kind: 'history', scope: { kind: 'head' }, text: 'new', cursor: null },
      'one',
      2,
    ),
  );
  release();
  await old;
  expect(reads).toStrictEqual(['new']);
  f.controller.dispose();
});
test('history, pagination, refresh and restore retain every filter option', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  const reads: HistoryInput[] = [];

  f.adapter.history = async (_id, input) => {
    reads.push(input);

    return { ...page([a]), nextCursor: input.cursor ? null : 'page-two' };
  };

  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({
      kind: 'history',
      scope: { kind: 'head' },
      text: '^Fix',
      cursor: null,
      filters,
    }),
  );
  await f.controller.handle(
    f.request(
      {
        kind: 'history',
        scope: { kind: 'head' },
        text: '^Fix',
        cursor: 'page-two',
        filters,
      },
      'one',
      2,
    ),
  );
  expect(reads.at(-1)?.cursor).toBe('page-two');
  expect(reads.at(-1)?.filters).toStrictEqual(filters);
  await f.controller.refresh();
  expect(reads.at(-1)?.filters).toStrictEqual(filters);
  const history = f.sent
    .filter((message) => message.body.kind === 'history')
    .at(-1)?.body;

  assert.ok(history?.kind === 'history');
  expect(history.filters).toStrictEqual(filters);
  await f.controller.handle(
    f.request(
      {
        kind: 'restore',
        scope: { kind: 'head' },
        text: '^Fix',
        filters,
        selection: null,
        anchor: null,
      },
      'one',
      3,
    ),
  );
  expect(reads.at(-1)?.filters).toStrictEqual(filters);
  f.controller.dispose();
});
test('changing filter options makes an old page request obsolete', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  let reads = 0;

  f.adapter.history = async () => {
    reads++;

    return { ...page([a]), nextCursor: 'page-two' };
  };

  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({
      kind: 'history',
      scope: { kind: 'head' },
      text: '',
      cursor: null,
      filters,
    }),
  );
  const before = reads;

  await f.controller.handle(
    f.request(
      {
        kind: 'history',
        scope: { kind: 'head' },
        text: '',
        cursor: 'page-two',
        filters: { ...filters, date: '24h' },
      },
      'one',
      2,
    ),
  );
  expect(reads).toBe(before);
  assert.ok(
    f.sent.some(
      (message) =>
        message.body.kind === 'error' && /obsolete/.test(message.body.message),
    ),
  );
  f.controller.dispose();
});
test('author picker returns repository identities while preserving other options', async (t) => {
  let offered: AuthorIdentity[] = [];
  const f = fixture(true, true, {
    pickAuthors: async (identities) => {
      offered = identities;

      return [bob];
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.authors = async () => [
    bob,
    { name: 'Alice', email: 'alice@example.test' },
  ];
  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({
      kind: 'history',
      scope: { kind: 'head' },
      text: '^Fix',
      cursor: null,
      filters: { ...filters, author: { kind: 'me' } },
    }),
  );
  await f.controller.handle(f.request({ kind: 'choose-authors' }, 'one', 2));
  expect(offered.length).toBe(2);
  expect(f.sent.at(-1)?.body).toStrictEqual({ kind: 'filters', filters });
  expect(f.writes).toStrictEqual([]);
  f.controller.dispose();
});
test('cancelled and stale author pickers cannot apply a query', async (t) => {
  let finish!: (authors: AuthorIdentity[] | null) => void;
  let opened!: () => void;
  let ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const f = fixture(true, true, {
    pickAuthors: () =>
      new Promise((resolve) => {
        finish = resolve;
        opened();
      }),
  });

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.authors = async () => [bob];
  await f.controller.selectRepository('one');
  const picking = f.controller.handle(f.request({ kind: 'choose-authors' }));

  t.onTestFinished(async () => {
    finish(null);
    await picking;
  });
  await ready;
  await f.controller.selectRepository('two');
  finish([bob]);
  await picking;
  assert.ok(!f.sent.some((message) => message.body.kind === 'filters'));
  ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const cancelling = f.controller.handle(
    f.request({ kind: 'choose-authors' }, 'two', 2),
  );

  t.onTestFinished(async () => {
    finish(null);
    await cancelling;
  });
  await ready;
  finish(null);
  await cancelling;
  assert.ok(!f.sent.some((message) => message.body.kind === 'filters'));
  f.controller.dispose();
});
test('author picker rejects identities absent from repository history', async (t) => {
  const f = fixture(true, true, {
    pickAuthors: async () => [
      { name: 'Forged', email: 'not-in-history@example.test' },
    ],
  });

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.authors = async () => [bob];
  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'choose-authors' }));
  assert.ok(!f.sent.some((message) => message.body.kind === 'filters'));
  assert.ok(f.sent.some((message) => message.body.kind === 'error'));
  expect(f.writes).toStrictEqual([]);
  f.controller.dispose();
});
test('a repository switch queued by the closing author picker cannot change the new repository filters', async (t) => {
  let switching: Promise<void> | null = null;
  const f = fixture(true, true, {
    pickAuthors: async () => {
      queueMicrotask(() => {
        switching = f.controller.selectRepository('two');
      });

      return [bob];
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.authors = async () => [bob];
  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'choose-authors' }));
  await switching;
  assert.ok(!f.sent.some((message) => message.body.kind === 'filters'));
  f.controller.dispose();
});
