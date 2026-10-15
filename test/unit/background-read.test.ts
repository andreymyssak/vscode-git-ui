import { afterEach, expect, test, vi } from 'vitest';

import { backgroundRead } from '../../src/extension/git/background-read';
import { deferred } from '../fixtures/deferred';

afterEach(() => vi.useRealTimers());

test('read deadlines abort the underlying process owner and release a never-settling read', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const outcome = backgroundRead(
    (owner) => {
      signal = owner;

      return new Promise<never>(() => {});
    },
    undefined,
    100,
  ).catch((error: unknown) => error);

  await vi.advanceTimersByTimeAsync(100);
  expect(signal?.aborted).toBe(true);
  expect(await outcome).toMatchObject({ name: 'TimeoutError' });
  expect(vi.getTimerCount()).toBe(0);
});

test('cancellation suppresses late native read results and removes the deadline timer', async () => {
  vi.useFakeTimers();
  const owner = new AbortController();
  const pending = deferred<string>();
  const outcome = backgroundRead(
    () => pending.promise,
    owner.signal,
    100,
  ).catch((error: unknown) => error);

  await vi.advanceTimersByTimeAsync(0);
  owner.abort();
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  pending.resolve('stale');
  await pending.promise;
  expect(vi.getTimerCount()).toBe(0);
});

test('successful reads release their timer without aborting caller ownership', async () => {
  vi.useFakeTimers();
  const owner = new AbortController();

  expect(await backgroundRead(async () => 'ready', owner.signal, 100)).toBe(
    'ready',
  );
  expect(owner.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
