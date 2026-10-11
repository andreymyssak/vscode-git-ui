class CancelledReadError extends DOMException {
  constructor() {
    super('The read was cancelled.', 'AbortError');
  }
}

export function readCancellationError(reason: unknown): Error {
  return reason instanceof Error ? reason : new CancelledReadError();
}

export function isReadCancellation(
  error: unknown,
  signal: AbortSignal,
): boolean {
  return (
    signal.aborted &&
    (error === signal.reason || error instanceof CancelledReadError)
  );
}

/** Releases read ownership on cancellation. The read must not include a mutation. */
export async function readWithCancellation<T>(
  read: () => PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw readCancellationError(signal.reason);
  if (!signal) return read();

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(readCancellationError(signal.reason));

    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();

        return read();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort);
          if (signal.aborted) reject(readCancellationError(signal.reason));
          else resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(
            signal.aborted
              ? readCancellationError(signal.reason)
              : error instanceof Error
                ? error
                : new Error('The read failed.', { cause: error }),
          );
        },
      );
  });
}
