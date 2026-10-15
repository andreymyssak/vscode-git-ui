import { readWithCancellation } from '../read-cancellation';

export const backgroundReadTimeoutMs = 120_000;

/** Read-only work may detach on cancellation; writes must never enter this scope. */
export async function backgroundRead<T>(
  read: (signal: AbortSignal) => PromiseLike<T>,
  signal?: AbortSignal,
  timeoutMs = backgroundReadTimeoutMs,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new DOMException(
          'Reading Git took too long. Refresh to try again.',
          'TimeoutError',
        ),
      ),
    timeoutMs,
  );

  timer.unref?.();
  const owner = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;

  try {
    return await readWithCancellation(() => read(owner), owner);
  } finally {
    clearTimeout(timer);
  }
}
