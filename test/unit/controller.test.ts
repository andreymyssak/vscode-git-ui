import { assert, expect, test, vi } from 'vitest';

import type { FileChange, HistoryPage } from '../../src/shared/model';
import { a, b, fixture, page } from '../fixtures/controller';

for (const [name, body, id] of [
  [
    'forged file handle does not open a path',
    { kind: 'open-file', fileId: '/arbitrary/secret', preview: true },
    'one',
  ],
  [
    'unknown repository cannot write',
    { kind: 'action', action: { kind: 'fetch-all' } },
    'outside',
  ],
  [
    'malformed action is rejected',
    {
      kind: 'action',
      action: { kind: 'checkout', refId: 'refs/heads/main', command: 'push' },
    },
    'one',
  ],
] as const)
  test(name, async (t) => {
    const f = fixture();

    t.onTestFinished(() => f.controller.dispose());
    await f.controller.selectRepository('one');
    f.sent.length = 0;
    await f.controller.handle({
      requestId: 'test',
      repositoryId: id,
      generation: 1,
      body,
    });
    expect(f.writes.length).toBe(0);
    expect(f.editors.length).toBe(0);
    assert.ok(
      f.sent.some((message) => message.body.kind === 'error'),
      'a rejected message must be reported',
    );
  });

test('cross repository handle is rejected', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'select-commit', sha: a }));
  await f.controller.selectRepository('two');
  f.sent.length = 0;
  await f.controller.handle(
    f.request(
      { kind: 'open-file', fileId: `one-${a}`, preview: true },
      'two',
      2,
    ),
  );
  expect(f.writes.length).toBe(0);
  expect(f.editors.length).toBe(0);
  assert.ok(f.sent.some((message) => message.body.kind === 'error'));
});

test('old generation cannot restore details', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  let finish!: (files: FileChange[]) => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });

  f.adapter.changes = async (id, sha) =>
    sha === a
      ? new Promise((resolve) => {
          finish = resolve;
          entered();
        })
      : [
          {
            id: `${id}-${sha}`,
            status: 'modified',
            oldPath: 'b.txt',
            newPath: 'b.txt',
          },
        ];
  const old = f.controller.handle(f.request({ kind: 'select-commit', sha: a }));

  await ready;
  t.onTestFinished(async () => {
    finish([]);
    await old;
  });

  await f.controller.handle(f.request({ kind: 'select-commit', sha: b }));
  finish([
    { id: 'old', status: 'modified', oldPath: 'old.txt', newPath: 'old.txt' },
  ]);
  await old;
  const files = f.sent.filter((message) => message.body.kind === 'files');

  assert.ok(files.length);
  expect(files.at(-1)?.body.kind).toBe('files');
  const last = files.at(-1)?.body;

  assert.ok(last?.kind === 'files');
  expect(last.sha).toBe(b);
  assert.ok(
    !files.some(
      (message) => message.body.kind === 'files' && message.body.sha === a,
    ),
  );
});

test('older history query cannot replace a newer query', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  let finish!: (value: HistoryPage) => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });

  f.adapter.history = async (_id, input) =>
    input.text === 'old'
      ? new Promise((resolve) => {
          finish = resolve;
          entered();
        })
      : page([b]);
  const old = f.controller.handle(
    f.request(
      { kind: 'history', scope: { kind: 'head' }, text: 'old', cursor: null },
      'one',
      2,
    ),
  );

  await ready;
  t.onTestFinished(async () => {
    finish(page([a]));
    await old;
  });
  await f.controller.handle(
    f.request(
      { kind: 'history', scope: { kind: 'head' }, text: 'new', cursor: null },
      'one',
      3,
    ),
  );
  finish(page([a]));
  await old;
  const histories = f.sent.filter((message) => message.body.kind === 'history');
  const last = histories.at(-1)?.body;

  assert.ok(last?.kind === 'history');
  expect(last.text).toBe('new');
  expect(last.page.commits.map((commit) => commit.sha)).toStrictEqual([b]);
});

test('disabled Git and untrusted workspace show setup states', async (t) => {
  for (const [trusted, enabled, state] of [
    [false, true, 'untrusted'],
    [true, false, 'git-disabled'],
  ] as const) {
    const f = fixture(trusted, enabled);

    t.onTestFinished(() => f.controller.dispose());
    let calls = 0;

    f.adapter.history = async () => {
      calls++;

      return page([]);
    };

    await f.controller.handle(
      f.request({ kind: 'ready', savedRepositoryId: null }, '', 0),
    );
    expect(calls).toBe(0);
    expect(f.writes.length).toBe(0);
    expect(f.editors.length).toBe(0);
    assert.ok(
      f.sent.some(
        (message) =>
          message.body.kind === 'setup' && message.body.state === state,
      ),
    );
  }
});

test('a newly opened repository replaces the no-repository setup', async (t) => {
  let published!: () => void;
  const updated = new Promise<void>((resolve) => {
    published = resolve;
  });
  const f = fixture(true, true, {
    send: async (message) => {
      f.sent.push(message);
      if (message.body.kind === 'history' && message.repositoryId === 'one')
        published();
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  const available = f.adapter.repositories;

  f.adapter.repositories = () => [];
  await f.controller.handle(
    f.request({ kind: 'ready', savedRepositoryId: null }, '', 0),
  );
  assert.ok(
    f.sent.some(
      (message) =>
        message.body.kind === 'setup' && message.body.state === 'no-repository',
    ),
  );
  f.adapter.repositories = available;
  f.fireRepositoryEvent();
  await updated;
  assert.ok(
    f.sent.some(
      (message) =>
        message.body.kind === 'history' && message.repositoryId === 'one',
    ),
  );
});

test('user filter intent survives a concurrent repository refresh', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  // The host has refreshed to generation 2 before the webview receives it.
  await f.controller.refresh();
  f.sent.length = 0;
  await f.controller.handle(
    f.request(
      {
        kind: 'history',
        scope: { kind: 'ref', refId: 'refs/heads/main' },
        text: '',
        cursor: null,
      },
      'one',
      2,
    ),
  );
  const history = f.sent
    .filter((message) => message.body.kind === 'history')
    .at(-1)?.body;

  assert.ok(history?.kind === 'history');
  expect(history.scope).toStrictEqual({
    kind: 'ref',
    refId: 'refs/heads/main',
  });
});

test('conflict results notify natively with Source Control recovery', async (t) => {
  const reportActionError = vi.fn(async () => {});
  const f = fixture(true, true, { reportActionError });

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.operate = async () => ({
    kind: 'conflict',
    backend: 'cli',
    message: 'Resolve through Source Control',
  });
  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({ kind: 'action', action: { kind: 'fetch-all' } }),
  );
  expect(f.sent.at(-1)?.body.kind).toBe('operation');
  expect(reportActionError).toHaveBeenCalledExactlyOnceWith(
    'Resolve through Source Control',
    true,
  );
});
