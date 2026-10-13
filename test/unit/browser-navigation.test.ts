import { expect, test, vi } from 'vitest';

import { recoverBrowserNavigation } from '../fixtures/browser-navigation';

test('a successful navigation returns its response without a recovery warning', async () => {
  const navigate = vi.fn(async () => 'loaded');
  const report = vi.fn();

  await expect(recoverBrowserNavigation({ navigate, report })).resolves.toBe(
    'loaded',
  );
  expect(report).not.toHaveBeenCalled();
});

test('one socket allocation failure is reported and the navigation can recover', async () => {
  const error = new Error('page.goto: net::ERR_NO_BUFFER_SPACE');
  const navigate = vi.fn(async () => 'loaded').mockRejectedValueOnce(error);
  const report = vi.fn();

  await expect(recoverBrowserNavigation({ navigate, report })).resolves.toBe(
    'loaded',
  );
  expect(report).toHaveBeenCalledExactlyOnceWith(error);
});

test('a second socket allocation failure propagates without a third attempt', async () => {
  const error = new Error('page.goto: net::ERR_NO_BUFFER_SPACE');
  const navigate = vi
    .fn(async () => 'loaded')
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error);

  await expect(
    recoverBrowserNavigation({ navigate, report: vi.fn() }),
  ).rejects.toBe(error);
  expect(navigate).toHaveBeenCalledTimes(2);
});

test.each([
  new Error('page.goto: net::ERR_CONNECTION_REFUSED'),
  new Error('expect(locator).toBeVisible() failed'),
  'net::ERR_NO_BUFFER_SPACE',
])('other failures propagate without retry: %s', async (error) => {
  const navigate = vi.fn(async () => 'loaded').mockRejectedValueOnce(error);
  const report = vi.fn();

  await expect(recoverBrowserNavigation({ navigate, report })).rejects.toBe(
    error,
  );
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
});

test('a bootstrap socket failure retries once and releases both request observers', async () => {
  const error = new Error('fake-vscode-host.js: net::ERR_NO_BUFFER_SPACE');
  let failed: ((error: Error) => void) | undefined;
  let attempts = 0;
  const stop = vi.fn();
  const observeFailures = vi.fn((record: (error: Error) => void) => {
    failed = record;

    return stop;
  });
  const navigate = vi.fn(async () => {
    if (++attempts === 1) failed?.(error);

    return 'loaded';
  });
  const report = vi.fn();

  await expect(
    recoverBrowserNavigation({ navigate, report, observeFailures }),
  ).resolves.toBe('loaded');
  expect(navigate).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledExactlyOnceWith(error);
  expect(stop).toHaveBeenCalledTimes(2);
});

test.each(['net::ERR_FAILED', 'net::ERR_NO_BUFFER_SPACE'])(
  'a persistent bootstrap failure propagates with bounded recovery: %s',
  async (reason) => {
    const error = new Error(`fake-vscode-host.js: ${reason}`);
    let failed: ((error: Error) => void) | undefined;
    const stop = vi.fn();
    const observeFailures = (record: (error: Error) => void) => {
      failed = record;

      return stop;
    };

    const navigate = vi.fn(async () => {
      failed?.(error);

      return 'loaded';
    });
    const attempts = reason === 'net::ERR_NO_BUFFER_SPACE' ? 2 : 1;

    await expect(
      recoverBrowserNavigation({ navigate, report: vi.fn(), observeFailures }),
    ).rejects.toBe(error);
    expect(navigate).toHaveBeenCalledTimes(attempts);
    expect(stop).toHaveBeenCalledTimes(attempts);
  },
);

test.each([
  { socketFirst: true, navigationRejects: false },
  { socketFirst: false, navigationRejects: false },
  { socketFirst: true, navigationRejects: true },
  { socketFirst: false, navigationRejects: true },
])(
  'ordinary bootstrap failures prevent recovery: %j',
  async ({ socketFirst, navigationRejects }) => {
    const socketError = new Error(
      'fake-vscode-host.js: net::ERR_NO_BUFFER_SPACE',
    );
    const ordinaryError = new Error('webview.js: net::ERR_FAILED');
    let failed: ((error: Error) => void) | undefined;
    const stop = vi.fn();
    const observeFailures = (record: (error: Error) => void) => {
      failed = record;

      return stop;
    };

    const navigate = vi.fn(async () => {
      for (const error of socketFirst
        ? [socketError, ordinaryError]
        : [ordinaryError, socketError])
        failed?.(error);

      if (navigationRejects) throw socketError;

      return 'loaded';
    });
    const report = vi.fn();

    await expect(
      recoverBrowserNavigation({ navigate, report, observeFailures }),
    ).rejects.toBe(ordinaryError);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  },
);

test('an ordinary navigation error takes precedence over an observed socket failure', async () => {
  const socketError = new Error(
    'fake-vscode-host.js: net::ERR_NO_BUFFER_SPACE',
  );
  const ordinaryError = new Error('page.goto: net::ERR_FAILED');
  let failed: ((error: Error) => void) | undefined;
  const observeFailures = (record: (error: Error) => void) => {
    failed = record;

    return vi.fn();
  };

  const navigate = vi.fn(async () => {
    failed?.(socketError);
    throw ordinaryError;
  });
  const report = vi.fn();

  await expect(
    recoverBrowserNavigation({ navigate, report, observeFailures }),
  ).rejects.toBe(ordinaryError);
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
});
