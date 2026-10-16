import { expect, test, vi } from 'vitest';

import { a, b, fixture, page } from '../fixtures/controller';

test('hidden history events invalidate immediately but coalesce presentation reads until reveal', async (t) => {
  const f = fixture();
  const reads = vi.spyOn(f.adapter, 'history');

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  await f.controller.setVisible(false);
  f.adapter.history = reads.mockResolvedValue(page([b, a]));
  for (let index = 0; index < 20; index++) f.fireHistoryEvent();
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(reads).toHaveBeenCalledTimes(1);
  await f.controller.setVisible(true);
  expect(reads).toHaveBeenCalledTimes(2);
  expect(f.sent.at(-1)?.body.kind).toBe('history-settled');
  const history = f.sent
    .filter((message) => message.body.kind === 'history')
    .at(-1);

  expect(
    history?.body.kind === 'history' && history.body.page.commits[0]?.sha,
  ).toBe(b);
});

test('revealing unchanged retained history does not rerun Git reads', async (t) => {
  const f = fixture();
  const reads = vi.spyOn(f.adapter, 'history');

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  await f.controller.setVisible(false);
  await f.controller.setVisible(true);
  expect(reads).toHaveBeenCalledTimes(1);
});

test('a controller initialized while hidden does not start history until its first reveal', async (t) => {
  const f = fixture(true, true, { visible: false });
  const reads = vi.spyOn(f.adapter, 'history');

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  expect(reads).not.toHaveBeenCalled();
  await f.controller.setVisible(true);
  expect(reads).toHaveBeenCalledTimes(1);
});
