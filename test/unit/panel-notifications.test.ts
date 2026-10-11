import { expect, test, vi } from 'vitest';

import { a, fixture, page } from '../fixtures/controller';

test('informational Log notices are sent through native notification feedback', async (t) => {
  const reportActionInfo = vi.fn();
  const f = fixture(true, true, { reportActionInfo });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'choose-authors' }));
  expect(reportActionInfo).toHaveBeenCalledExactlyOnceWith(
    'No commit authors are available in this repository.',
  );
});

test('history failures notify natively and repeated refreshes stay quiet until recovery', async (t) => {
  const reportActionError = vi.fn(async () => {});
  const f = fixture(true, true, { reportActionError });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  f.adapter.history = async () => {
    throw new Error('History unavailable');
  };

  await f.controller.refresh();
  await f.controller.refresh();
  expect(reportActionError).toHaveBeenCalledExactlyOnceWith(
    'History unavailable',
  );
  expect(f.sent.at(-1)?.body).toEqual({
    kind: 'error',
    message: 'History unavailable',
  });
  f.adapter.history = async () => page([a]);
  await f.controller.refresh();
  f.adapter.history = async () => {
    throw new Error('History unavailable');
  };

  await f.controller.refresh();
  expect(reportActionError).toHaveBeenCalledTimes(2);
});

test('worktree failures stay quiet across successful history refreshes until worktrees recover', async (t) => {
  const reportActionError = vi.fn(async () => {});
  const f = fixture(true, true, { reportActionError });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  f.adapter.worktrees = async () => {
    throw new Error('Worktrees unavailable');
  };

  await f.controller.refresh();
  await f.controller.refresh();
  expect(reportActionError).toHaveBeenCalledExactlyOnceWith(
    'Worktrees unavailable',
  );
  f.adapter.worktrees = async () => [];
  await f.controller.handle(f.request({ kind: 'worktrees' }, 'one', 3));
  f.adapter.worktrees = async () => {
    throw new Error('Worktrees unavailable');
  };

  await f.controller.handle(f.request({ kind: 'worktrees' }, 'one', 3));
  expect(reportActionError).toHaveBeenCalledTimes(2);
});

test('comparison failures notify once across refreshes and can recover through toolbar refresh', async (t) => {
  const reportActionError = vi.fn(async () => {});
  const f = fixture(true, true, { reportActionError });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  f.adapter.changes = async () => {
    throw new Error('Comparison unavailable');
  };

  await f.controller.handle(f.request({ kind: 'select-commit', sha: a }));
  await f.controller.refresh();
  expect(reportActionError).toHaveBeenCalledExactlyOnceWith(
    'Comparison unavailable',
  );
  expect(f.sent.some(({ body }) => body.kind === 'files-error')).toBe(true);
  f.adapter.changes = async () => [];
  await f.controller.handle(f.request({ kind: 'refresh' }, 'one', 2));
  expect(
    f.sent.some(({ body }) => body.kind === 'files' && body.files.length === 0),
  ).toBe(true);
});

test('explicit Refresh retries report a repeated read failure after background refresh stays quiet', async (t) => {
  const reportActionError = vi.fn(async () => {});
  const f = fixture(true, true, { reportActionError });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  f.adapter.history = async () => {
    throw new Error('History unavailable');
  };

  await f.controller.refresh();
  await f.controller.refresh();
  expect(reportActionError).toHaveBeenCalledTimes(1);
  await f.controller.handle(f.request({ kind: 'refresh' }, 'one', 3));
  expect(reportActionError).toHaveBeenCalledTimes(2);
  await f.controller.refresh();
  expect(reportActionError).toHaveBeenCalledTimes(2);
});

test('explicit Worktree refresh reports repeated list failures while automatic requests stay quiet', async (t) => {
  const reportActionError = vi.fn(async () => {});
  const f = fixture(true, true, { reportActionError });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  f.adapter.worktrees = async () => {
    throw new Error('Worktrees unavailable');
  };

  await f.controller.handle(f.request({ kind: 'worktrees' }));
  await f.controller.handle(f.request({ kind: 'worktrees' }));
  expect(reportActionError).toHaveBeenCalledTimes(1);
  await f.controller.handle(f.request({ kind: 'worktrees', retry: true }));
  expect(reportActionError).toHaveBeenCalledTimes(2);
});

test('invalid dates use a native notification without changing history', async (t) => {
  const reportActionError = vi.fn(async () => {});
  const f = fixture(true, true, { reportActionError });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  f.sent.length = 0;
  await f.controller.handle(f.request({ kind: 'invalid-date-filter' }));
  expect(reportActionError).toHaveBeenCalledExactlyOnceWith(
    'Start date must be on or before end date.',
  );
  expect(f.sent).toEqual([]);
});

test('explicit editor failures always notify', async (t) => {
  const reportActionError = vi.fn(async () => {});
  const f = fixture(true, true, {
    reportActionError,
    openChange: async () => {
      throw new Error('Editor unavailable');
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'select-commit', sha: a }));
  for (const preview of [true, false])
    await f.controller.handle(
      f.request({ kind: 'open-file', fileId: `one-${a}`, preview }),
    );
  expect(reportActionError).toHaveBeenCalledTimes(2);
  expect(reportActionError).toHaveBeenLastCalledWith('Editor unavailable');
});

test('obsolete comparison failures do not notify after the user selects another commit', async (t) => {
  const reportActionError = vi.fn(async () => {});
  const f = fixture(true, true, { reportActionError });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  let fail!: (error: Error) => void;

  f.adapter.changes = async (_id, sha) =>
    sha === a
      ? new Promise((_resolve, reject) => {
          fail = reject;
        })
      : [];
  const reading = f.controller.handle(
    f.request({ kind: 'select-commit', sha: a }),
  );

  await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
  await f.controller.handle(
    f.request({ kind: 'select-commit', sha: 'b'.repeat(40) }),
  );
  fail(new Error('Old comparison unavailable'));
  await reading;
  expect(reportActionError).not.toHaveBeenCalled();
});
