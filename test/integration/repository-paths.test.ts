import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { GitCli } from '../../src/extension/git/cli';
import { createFixture } from '../fixtures/repository';
import { squashAccess } from '../fixtures/squash-repository';

test.skipIf(process.platform === 'win32').each([' ', '\t', '\n', '\r'])(
  'Git commands preserve a repository root ending in %j',
  async (suffix) => {
    const fixture = await createFixture({ prefix: 'git-ui path boundary ' });

    try {
      const root = join(fixture.root, `repository${suffix}`);

      await mkdir(root);
      await fixture.runGit(['init', '--initial-branch=main', root]);
      const cli = new GitCli(squashAccess(root));

      expect(
        await cli.run('fixture', ['rev-parse', '--is-inside-work-tree']),
      ).toBe('true\n');
    } finally {
      await fixture.dispose();
    }
  },
);

test('Git commands still reject a nested directory posing as the repository root', async () => {
  const fixture = await createFixture({ prefix: 'git-ui path guard ' });

  try {
    const nested = join(fixture.root, 'nested');

    await mkdir(nested);
    let executed = false;

    await expect(
      new GitCli(squashAccess(nested)).run(
        'fixture',
        ['rev-parse', '--is-inside-work-tree'],
        undefined,
        () => {
          executed = true;
        },
      ),
    ).rejects.toThrow('Repository root changed');
    expect(executed).toBe(false);
  } finally {
    await fixture.dispose();
  }
});
