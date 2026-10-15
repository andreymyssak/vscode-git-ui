import { realpath } from 'node:fs/promises';

import { readWithCancellation } from '../read-cancellation';
import type { GitCli } from './cli';
import { repositoryOperations } from './operation-queue';

export async function withRepositoryOperation<T>(
  cli: Pick<GitCli, 'run'>,
  id: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
  acquired?: () => void | Promise<void>,
): Promise<T> {
  return repositoryOperations.run(id, async () => {
    signal?.throwIfAborted();
    const directory = await readWithCancellation(
      async () =>
        realpath(
          (
            await cli.run(
              id,
              ['rev-parse', '--path-format=absolute', '--git-common-dir'],
              signal,
            )
          ).replace(/\r?\n$/, ''),
        ),
      signal,
    );
    const key =
      process.platform === 'win32' ? directory.toLowerCase() : directory;

    return repositoryOperations.run(`common:${key}`, async () => {
      signal?.throwIfAborted();
      await acquired?.();

      return action();
    });
  });
}
