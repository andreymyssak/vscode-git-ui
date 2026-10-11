import { realpath } from 'node:fs/promises';

import type { GitCli } from './cli';
import { repositoryOperations } from './operations';

export async function withRepositoryOperation<T>(
  cli: Pick<GitCli, 'run'>,
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  return repositoryOperations.run(id, async () => {
    const directory = await realpath(
      (
        await cli.run(id, [
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ])
      ).replace(/\r?\n$/, ''),
    );
    const key =
      process.platform === 'win32' ? directory.toLowerCase() : directory;

    return repositoryOperations.run(`common:${key}`, action);
  });
}
