import { readCancellationError } from '../read-cancellation';

export interface GitApiInitialization {
  readonly state: 'uninitialized' | 'initialized';
  onDidChangeState(
    listener: (state: 'uninitialized' | 'initialized') => void,
  ): { dispose(): void };
}

export async function waitForGitInitialization(
  api: GitApiInitialization,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw readCancellationError(signal.reason);
  if (api.state === 'initialized') return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      subscription.dispose();
      reject(readCancellationError(signal?.reason));
    };

    const subscription = api.onDidChangeState((state) => {
      if (state !== 'initialized') return;
      subscription.dispose();
      signal?.removeEventListener('abort', abort);
      resolve();
    });

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
