import { expect, test, vi } from 'vitest';

import { a, b, fixture, page } from '../fixtures/controller';

test('a repository change invalidates in-flight history before the refresh debounce', async (t) => {
  vi.useFakeTimers();
  const f = fixture();
  let finish: (value: ReturnType<typeof page>) => void = () => {};

  const pendingPage = new Promise<ReturnType<typeof page>>((resolve) => {
    finish = resolve;
  });
  let started: () => void = () => {};

  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let reads = 0;
  const fresh = 'c'.repeat(40);

  f.adapter.history = async () => {
    if (++reads === 1) return page([a]);
    if (reads === 2) {
      started();

      return pendingPage;
    }

    return page([fresh]);
  };

  t.onTestFinished(() => {
    finish(page([a, b]));
    f.controller.dispose();
    vi.useRealTimers();
  });
  await f.controller.selectRepository('one');
  const before = f.sent.length;
  const pending = f.controller.handle(
    f.request({
      kind: 'history',
      scope: { kind: 'head' },
      text: '',
      cursor: null,
    }),
  );

  await reading;
  f.fireHistoryEvent();
  finish(page([a, b]));
  await pending;
  expect(
    f.sent.slice(before).filter((message) => message.body.kind === 'history'),
  ).toEqual([]);
  await vi.advanceTimersByTimeAsync(50);
  const histories = f.sent
    .slice(before)
    .flatMap((message) =>
      message.body.kind === 'history'
        ? [message.body.page.commits.map((commit) => commit.sha)]
        : [],
    );

  expect(histories).toEqual([[fresh]]);
});
