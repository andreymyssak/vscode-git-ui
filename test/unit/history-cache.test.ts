import { assert, expect, test } from 'vitest';

import type {
  GitApiAccess,
  GitCommit,
  GitLogOptions,
} from '../../src/extension/git/api';
import type { GitCli } from '../../src/extension/git/cli';
import { createHistoryQueries } from '../../src/extension/git/history';
import type { HistoryInput } from '../../src/shared/model';
import { fixture as panelFixture } from '../fixtures/controller';
import { completeHistoryShallow } from '../fixtures/history-shallow';

const sha = (index: number) => index.toString(16).padStart(40, '0');
const input = (refId = 'refs/heads/main', text = ''): HistoryInput => ({
  scope: { kind: 'ref', refId },
  text,
  cursor: null,
});

function fixture(tracking = false) {
  const records: GitCommit[] = Array.from({ length: 221 }, (_, index) => ({
    hash: sha(index + 1),
    parents: [sha(index + 2)],
    message: `Commit ${index + 1}`,
  }));
  const refs = [
    { type: 0, name: 'main', commit: sha(1) },
    { type: 0, name: 'topic', commit: sha(201) },
  ];
  const reads: {
    id: string;
    options: GitLogOptions;
  }[] = [];
  let now = 0;
  let gate: (() => Promise<void>) | undefined;
  const access = {
    repository: (id: string) => ({
      state: { HEAD: { commit: refs[0]!.commit } },
      getRefs: async () => refs.map((ref) => ({ ...ref })),
      getCommit: async (ref: string) =>
        records.find(
          (record) => record.hash === (ref === 'HEAD' ? refs[0]!.commit : ref),
        )!,
      log: async (options: GitLogOptions) => {
        reads.push({ id, options });
        await gate?.();
        const start = records.findIndex(
          (record) => record.hash === options.refNames?.[0],
        );

        return records.slice(
          start + (options.skip ?? 0),
          start + (options.skip ?? 0) + 200,
        );
      },
    }),
  } as unknown as GitApiAccess;
  const reader = createHistoryQueries(
    access,
    {
      readOnly() {
        return this;
      },
      run: async (_id: string, args: string[]) =>
        tracking && args[0] === 'for-each-ref'
          ? `refs/heads/main\0${sha(1)}\0refs/remotes/origin/main\0[behind 1]`
          : '',
    } as unknown as GitCli,
    () => now,
    completeHistoryShallow,
  );

  return {
    reader,
    records,
    reads,
    refs,
    setTime: (value: number) => {
      now = value;
    },
    setGate: (value: typeof gate) => {
      gate = value;
    },
  };
}

test('returning to an inactive repository rereads history even if its tips did not change', async (t) => {
  const { reader, refs, records, reads } = fixture();
  const f = panelFixture();

  t.onTestFinished(() => f.controller.dispose());
  refs[0]!.commit = sha(201);
  f.adapter.history = (id, request, signal) => reader.page(id, request, signal);
  f.adapter.invalidateHistory = (id) => reader.invalidate(id);
  await f.controller.selectRepository('one');
  await f.controller.selectRepository('two');
  // A shallow repository can gain ancestors without changing any reference tip.
  records.push({
    hash: sha(222),
    parents: [sha(223)],
    message: 'Newly available ancestor',
  });
  await f.controller.selectRepository('one');
  const last = f.sent
    .filter((message) => message.body.kind === 'history')
    .at(-1)!;

  expect(last.body.kind).toBe('history');
  if (last.body.kind === 'history') {
    expect(last.body.page.commits.length).toBe(22);
    expect(last.body.page.commits.at(-1)?.message).toBe(
      'Newly available ancestor',
    );
  }

  expect(reads.length).toBe(3);
  f.controller.dispose();
});
test('revisiting a branch reuses both loaded pages and issues usable fresh cursors', async () => {
  const { reader, reads } = fixture();
  const first = await reader.page('one', input());
  const second = await reader.page('one', {
    ...input(),
    cursor: first.nextCursor,
  });
  const topic = await reader.page('one', input('refs/heads/topic'));
  const revisit = await reader.page('one', input());
  const revisitedSecond = await reader.page('one', {
    ...input(),
    cursor: revisit.nextCursor,
  });

  expect(reads.length, 'cached visits must not rerun history traversal').toBe(
    3,
  );
  expect(topic.commits.map((commit) => commit.sha)).toStrictEqual(
    Array.from({ length: 21 }, (_, index) => sha(201 + index)),
  );
  expect(revisit.commits).toStrictEqual(first.commits);
  expect(revisitedSecond.commits).toStrictEqual(second.commits);
  expect(revisitedSecond.nextCursor).toBe(null);
  expect(revisit.nextCursor).not.toBe(first.nextCursor);
});
test('cache isolation preserves repository and search query ownership', async () => {
  const { reader, reads } = fixture();

  await reader.page('one', input());
  await reader.page('two', input());
  await reader.page('one', input('refs/heads/main', 'message'));
  await reader.page('one', input());
  expect(reads.length).toBe(3);
  expect(reads.map((read) => read.id)).toStrictEqual(['one', 'two', 'one']);
});
test('fresh queries observe moved and deleted refs even before repository events', async () => {
  const { reader, refs } = fixture();

  await reader.page('one', input());
  refs[0]!.commit = sha(201);
  const moved = await reader.page('one', input());

  expect(moved.commits[0]?.sha).toBe(sha(201));
  refs.splice(1, 1);
  await expect(reader.page('one', input('refs/heads/topic'))).rejects.toThrow(
    /no longer exists/,
  );
});
test('repository invalidation revokes cached pages and cursors without affecting another repository', async () => {
  const { reader, reads } = fixture();
  const first = await reader.page('one', input());

  await reader.page('two', input());
  reader.invalidate('one');
  await expect(
    reader.page('one', { ...input(), cursor: first.nextCursor }),
  ).rejects.toThrow(/History changed/);
  await reader.page('two', input());
  await reader.page('one', input());
  expect(reads.length).toBe(3);
});
test('an invalidated in-flight read cannot repopulate the history cache', async (t) => {
  const { reader, reads, setGate } = fixture();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });

  setGate(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered();
      }),
  );
  const pending = reader.page('one', input());

  await ready;
  t.onTestFinished(async () => {
    release();
    await Promise.allSettled([pending]);
  });
  reader.invalidate('one');
  release();
  await expect(pending).rejects.toThrow(/History changed/);
  setGate(undefined);
  await reader.page('one', input());
  expect(reads.length).toBe(2);
});
test('aborted history reads are not cached', async () => {
  const { reader, reads, setGate } = fixture();
  const cancellation = new AbortController();

  setGate(async () => {
    cancellation.abort();
  });
  await expect(
    reader.page('one', input(), cancellation.signal),
  ).rejects.toThrow();
  setGate(undefined);
  await reader.page('one', input());
  await reader.page('one', input());
  expect(reads.length).toBe(2);
});
test('expired results and least-recently-used pages are reloaded', async () => {
  const { reader, reads, setTime } = fixture();

  await reader.page('one', input());
  await reader.page('one', input());
  expect(reads.length).toBe(1);
  setTime(61000);
  await reader.page('one', input());
  expect(reads.length).toBe(2);
  for (let index = 0; index < 21; index++)
    await reader.page('one', input('refs/heads/main', `query ${index}`));
  await reader.page('one', input('refs/heads/main', 'query 20'));
  expect(reads.length).toBe(23);
  await reader.page('one', input());
  expect(reads.length).toBe(24);
});
test('cache hits do not prolong the freshness interval', async () => {
  const { reader, reads, setTime } = fixture();

  await reader.page('one', input());
  setTime(30000);
  await reader.page('one', input());
  setTime(61000);
  await reader.page('one', input());
  expect(reads.length).toBe(2);
});
test('returned records and reference labels cannot corrupt later cached results', async () => {
  const { reader } = fixture();
  const first = await reader.page('one', input());

  first.commits[0]!.message = 'Changed by consumer';
  first.refs[0]!.name = 'Changed by consumer';
  const second = await reader.page('one', input());

  expect(second.commits[0]!.message).toBe('Commit 1');
  expect(second.refs[0]!.name).toBe('main');
});
test('returned tracking counts cannot corrupt cached references', async () => {
  const { reader, reads } = fixture(true);
  const first = await reader.page('one', input());

  assert.ok(first.refs[0]?.tracking);
  expect(first.refs[0].tracking.behind).toBe(1);
  first.refs[0].tracking.behind = 999;
  const cached = await reader.page('one', input());

  expect(cached.refs[0]?.tracking?.behind).toBe(1);
  expect(reads.length).toBe(1);
});
