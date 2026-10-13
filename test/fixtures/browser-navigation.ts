import { setTimeout } from 'node:timers/promises';

export async function recoverBrowserNavigation<T>({
  navigate,
  report,
  observeFailures,
}: {
  navigate(this: void): Promise<T>;
  report(this: void, error: Error): void;
  observeFailures?(record: (error: Error) => void): () => void;
}): Promise<T> {
  const attempt = async () => {
    let failure: Error | undefined;
    const stop = observeFailures?.((error) => {
      if (!failure || (isSocketFailure(failure) && !isSocketFailure(error)))
        failure = error;
    });

    try {
      const response = await navigate();

      if (failure) throw failure;

      return response;
    } catch (error) {
      if (!isSocketFailure(error)) throw error;

      throw failure ?? error;
    } finally {
      stop?.();
    }
  };

  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof Error) || !isSocketFailure(error)) throw error;
    report(error);
    await setTimeout(100);

    return attempt();
  }
}

function isSocketFailure(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('net::ERR_NO_BUFFER_SPACE')
  );
}
