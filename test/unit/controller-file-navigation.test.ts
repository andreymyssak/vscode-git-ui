import { expect, onTestFinished, test } from 'vitest';

import { a, b, fixture, page } from '../fixtures/controller';

test.each(['docs/architecture.md', 'docs/old-architecture.md'])(
  'a blame jump selects the changed file for %s without opening a diff',
  async (path) => {
    const f = fixture();

    onTestFinished(() => f.controller.dispose());
    f.adapter.resolve = async () => ({
      kind: 'commit',
      commit: { ...page([b]).commits[0]!, parents: [a] },
    });
    f.adapter.changes = async () => [
      {
        id: 'architecture',
        status: 'renamed',
        oldPath: 'docs/old-architecture.md',
        newPath: 'docs/architecture.md',
      },
    ];
    await f.controller.selectRepository('one');
    f.sent.length = 0;
    await f.controller.revealCommit({
      repositoryId: 'one',
      sha: b,
      filePath: path,
    });
    expect(
      f.sent.filter(({ body }) => body.kind === 'selection').at(-1)?.body,
    ).toEqual({
      kind: 'selection',
      sha: b,
      parentSha: a,
      filePath: 'docs/architecture.md',
      anchor: { sha: b, offset: 0 },
    });
    expect(f.editors).toEqual([]);
    expect(f.writes).toEqual([]);
  },
);

test('a blame jump does not select an unrelated file when its path is absent', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.resolve = async () => ({
    kind: 'commit',
    commit: page([b]).commits[0]!,
  });
  await f.controller.revealCommit({
    repositoryId: 'one',
    sha: b,
    filePath: 'missing.md',
  });
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toHaveLength(1);
  expect(f.sent.filter(({ body }) => body.kind === 'selection')).toEqual([]);
  expect(f.editors).toEqual([]);
});

test('a blame jump finds the file in another merge parent comparison', async (t) => {
  const f = fixture();
  const second = 'c'.repeat(40);

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.resolve = async () => ({
    kind: 'commit',
    commit: { ...page([b]).commits[0]!, parents: [a, second] },
  });
  f.adapter.changes = async (_id, _sha, parentSha) =>
    parentSha === second
      ? [
          {
            id: 'architecture',
            status: 'modified',
            oldPath: 'docs/architecture.md',
            newPath: 'docs/architecture.md',
          },
        ]
      : [];
  await f.controller.revealCommit({
    repositoryId: 'one',
    sha: b,
    filePath: 'docs/architecture.md',
  });
  expect(
    f.sent.filter(({ body }) => body.kind === 'selection').at(-1)?.body,
  ).toMatchObject({
    sha: b,
    parentSha: second,
    filePath: 'docs/architecture.md',
  });
  expect(f.editors).toEqual([]);
});

test('a cancelled blame source cannot select a file after its read completes', async (t) => {
  const f = fixture();
  let current = true;
  let finish!: () => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });

  t.onTestFinished(() => {
    finish();
    f.controller.dispose();
  });
  f.adapter.resolve = async () => ({
    kind: 'commit',
    commit: page([b]).commits[0]!,
  });
  f.adapter.changes = async () => {
    started();
    await held;

    return [
      {
        id: 'architecture',
        status: 'modified',
        oldPath: 'docs/architecture.md',
        newPath: 'docs/architecture.md',
      },
    ];
  };

  const jump = f.controller.revealCommit(
    { repositoryId: 'one', sha: b, filePath: 'docs/architecture.md' },
    () => current,
  );

  await reading;
  current = false;
  finish();
  await jump;
  expect(f.sent.filter(({ body }) => body.kind === 'selection')).toEqual([]);
  expect(f.sent.filter(({ body }) => body.kind === 'files')).toEqual([]);
});

test.each(['open-file', 'load-parent'] satisfies ReadonlyArray<
  'open-file' | 'load-parent'
>)('a pending blame file reveal respects %s requests', async (kind) => {
  const f = fixture();
  const second = 'c'.repeat(40);
  let finish!: () => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });

  onTestFinished(() => {
    finish();
    f.controller.dispose();
  });
  f.adapter.resolve = async () => ({
    kind: 'commit',
    commit: { ...page([b]).commits[0]!, parents: [a, second] },
  });
  f.adapter.changes = async (_id, _sha, parentSha) => {
    if (parentSha === second) {
      started();
      await held;
    }

    const path = parentSha === second ? 'src/origin.ts' : 'src/manual.ts';

    return [{ id: path, status: 'modified', oldPath: path, newPath: path }];
  };

  const jump = f.controller.revealCommit({
    repositoryId: 'one',
    sha: b,
    filePath: 'src/origin.ts',
  });

  await reading;
  const generation = f.sent.at(-1)!.generation;

  await f.controller.handle(
    f.request(
      kind === 'open-file'
        ? { kind, fileId: 'src/manual.ts', preview: true }
        : { kind, sha: b, parentSha: a },
      'one',
      generation,
    ),
  );
  finish();
  await jump;
  const selections = f.sent.filter(({ body }) => body.kind === 'selection');

  if (kind === 'open-file') {
    expect(f.editors).toHaveLength(1);
    expect(selections).toEqual([]);
  } else {
    expect(selections.at(-1)?.body).toMatchObject({
      sha: b,
      parentSha: second,
      filePath: 'src/origin.ts',
    });
  }
});
