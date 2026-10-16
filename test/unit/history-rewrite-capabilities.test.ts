import { expect, test } from 'vitest';

import { validateMessageEdit } from '../../src/extension/git/message-edit';
import { validateSquash } from '../../src/extension/git/squash';
import { squashAccess } from '../fixtures/squash-repository';

test.each([
  'git version 2.46.9',
  'git version 2.47.0-rc1',
  'git version 2.47.0 (custom vendor)',
  'unknown',
])(
  'history rewrite entry points reject unverified Git %s before repository reads',
  async (version) => {
    const reads: string[][] = [];
    const cli = {
      run: async (_id: string, args: readonly string[]) => {
        reads.push([...args]);
        if (args[0] !== '--version')
          throw new Error('Unexpected repository read');

        return version;
      },
    };
    const access = squashAccess('/unused');
    const head = 'a'.repeat(40);

    await expect(
      validateSquash(access, cli, 'fixture', {
        shas: [],
        expectedBranch: 'main',
        expectedHeadSha: head,
      }),
    ).rejects.toThrow('Git 2.47 or newer');
    await expect(
      validateMessageEdit(access, cli, 'fixture', 'b'.repeat(40), 'main', head),
    ).rejects.toThrow('Git 2.47 or newer');
    expect(reads).toEqual([['--version'], ['--version']]);
  },
);

test('editing the current HEAD does not require the history rewrite capability', async () => {
  const reads: string[][] = [];
  const cli = {
    run: async (_id: string, args: readonly string[]) => {
      reads.push([...args]);
      throw new Error('Repository safety check');
    },
  };
  const head = 'a'.repeat(40);

  await expect(
    validateMessageEdit(
      squashAccess('/unused'),
      cli,
      'fixture',
      head,
      'main',
      head,
    ),
  ).rejects.toThrow('Repository safety check');
  expect(reads.some((args) => args[0] === '--version')).toBe(false);
});
