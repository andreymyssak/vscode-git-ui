import { expect, test } from 'vitest';

import { createChangeQueries } from '../../src/extension/git/changes';
import { GitCli } from '../../src/extension/git/cli';
import { deferred } from '../fixtures/deferred';
import { createSquashFixture } from '../fixtures/squash-repository';

test('concurrent identical immutable comparisons share a read and return independent arrays', async () => {
  const f = await createSquashFixture();
  const held = deferred<void>();
  const entered = deferred<void>();
  let reads = 0;

  try {
    const repo = f.access.repository('fixture');

    repo.getCommit = async (sha) => ({
      hash: sha,
      parents: [],
      message: 'Fixture',
    });
    repo.diffBetween = async () => {
      reads++;
      entered.resolve();
      await held.promise;

      return [];
    };

    const changes = createChangeQueries(f.access, new GitCli(f.access));
    const first = changes('fixture', f.c, f.b);

    await entered.promise;
    const second = changes('fixture', f.c, f.b);

    held.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(reads).toBe(1);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    await changes('fixture', f.c, f.b);
    expect(reads).toBe(1);
  } finally {
    held.resolve();
    await f.dispose();
  }
});

test('a failed shared comparison can be retried without retaining its rejected promise', async () => {
  const f = await createSquashFixture();

  try {
    const repo = f.access.repository('fixture');

    repo.getCommit = async (sha) => ({
      hash: sha,
      parents: [],
      message: 'Fixture',
    });
    let reads = 0;

    repo.diffBetween = async () => {
      if (++reads === 1) throw new Error('Temporary comparison failure');

      return [];
    };

    const changes = createChangeQueries(f.access, new GitCli(f.access));

    await expect(changes('fixture', f.c, f.b)).rejects.toThrow(
      'Temporary comparison failure',
    );
    await expect(changes('fixture', f.c, f.b)).resolves.toEqual([]);
    expect(reads).toBe(2);
  } finally {
    await f.dispose();
  }
});
