import { onTestFinished } from 'vitest';

import { createOperations } from '../../src/extension/git/operations';
import { createSquashFixture } from './squash-repository';

/** Real Git fixture with the native patch API contract reproduced at its boundary. */
export async function selectedCommitFixture(
  objectFormat: 'sha1' | 'sha256' = 'sha1',
) {
  const f = await createSquashFixture(objectFormat);

  onTestFinished(() => f.dispose());
  const repo = f.access.repository('fixture');

  Object.assign(f.access.api, {
    onDidCloseRepository: () => ({ dispose() {} }),
  });
  repo.getCommit = async (ref) => ({
    hash: (await f.runGit(['rev-parse', ref])).trim(),
    message: (await f.runGit(['show', '-s', '--format=%B', ref])).trim(),
    parents: (await f.runGit(['show', '-s', '--format=%P', ref]))
      .trim()
      .split(' ')
      .filter(Boolean),
  });
  repo.status = async () => {};

  repo.apply = async (patch, options) => {
    if (options?.threeWay !== true)
      throw new Error('Expected native three-way application.');
    await f.runGit([
      'apply',
      '--3way',
      ...(options.reverse ? ['--reverse'] : []),
      patch,
    ]);
  };

  const operate = createOperations(f.access, f.cli, {
    remoteCheckout: async () => null,
    updateDiverged: async () => null,
  });

  return { ...f, operate };
}
