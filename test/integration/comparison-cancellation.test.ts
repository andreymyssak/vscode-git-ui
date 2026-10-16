import { expect, test, vi } from 'vitest';

import type { GitCommit } from '../../src/extension/git/api';
import { createChangeQueries } from '../../src/extension/git/changes';
import { deferred } from '../fixtures/deferred';
import { createSquashFixture } from '../fixtures/squash-repository';

async function promptly<T>(promise: Promise<T>): Promise<T | 'still pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<'still pending'>((resolve) => {
        timer = setTimeout(() => resolve('still pending'), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.each(['signal', 'no signal'])(
  'cancelling one comparison consumer preserves another with %s',
  async (secondOwner) => {
    const f = await createSquashFixture();
    const entered = deferred<void>();
    const held = deferred<void>();
    const firstOwner = new AbortController();
    const reason = new Error('The first viewer selected another commit.');
    const repo = f.access.repository('fixture');
    let reads = 0;

    repo.getCommit = async (hash) => ({ hash, parents: [], message: 'Parent' });
    repo.diffBetween = async () => {
      reads++;
      entered.resolve();
      await held.promise;

      return [];
    };

    const changes = createChangeQueries(f.access, f.cli);
    const first = changes('fixture', f.c, f.b, firstOwner.signal).catch(
      (error: unknown) => error,
    );

    try {
      await entered.promise;
      const second = changes(
        'fixture',
        f.c,
        f.b,
        secondOwner === 'signal' ? new AbortController().signal : undefined,
      );

      firstOwner.abort(reason);
      expect(await promptly(first)).toBe(reason);
      held.resolve();
      await expect(second).resolves.toEqual([]);
      expect(reads).toBe(1);
      await expect(changes('fixture', f.c, f.b)).resolves.toEqual([]);
      expect(reads).toBe(1);
    } finally {
      held.resolve();
      await first;
      await f.dispose();
    }
  },
);

test('the final consumer releases an unabortable parent read without a late comparison', async () => {
  const f = await createSquashFixture();
  const entered = deferred<void>();
  const held = deferred<GitCommit>();
  const owner = new AbortController();
  const reason = new DOMException('The viewer was closed.', 'AbortError');
  const repo = f.access.repository('fixture');
  let parents = 0;
  let comparisons = 0;

  repo.getCommit = async (hash) => {
    if (++parents === 1) {
      entered.resolve();

      return held.promise;
    }

    return { hash, parents: [], message: 'Parent' };
  };

  repo.diffBetween = async () => {
    comparisons++;

    return [];
  };

  const changes = createChangeQueries(f.access, f.cli);
  const first = changes('fixture', f.c, f.b, owner.signal).catch(
    (error: unknown) => error,
  );

  try {
    await entered.promise;
    owner.abort(reason);
    expect(await promptly(first)).toBe(reason);
    await expect(changes('fixture', f.c, f.b)).resolves.toEqual([]);
    held.resolve({ hash: f.b, parents: [], message: 'Obsolete parent' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(changes('fixture', f.c, f.b)).resolves.toEqual([]);
    expect(parents).toBe(2);
    expect(comparisons).toBe(1);
  } finally {
    held.resolve({ hash: f.b, parents: [], message: 'Parent' });
    await first;
    await f.dispose();
  }
});

test.each(['cat-file', 'diff-tree'])(
  'the final root-comparison consumer aborts its %s owner and starts fresh on retry',
  async (command) => {
    const f = await createSquashFixture();
    const entered = deferred<void>();
    const held = deferred<string>();
    const owner = new AbortController();
    const reason = new Error('The root comparison was superseded.');
    const run = f.cli.run.bind(f.cli);
    let readOwner: AbortSignal | undefined;
    let hold = true;

    vi.spyOn(f.cli, 'run').mockImplementation(async (id, args, signal) => {
      if (hold && args[0] === command) {
        hold = false;
        readOwner = signal;
        entered.resolve();

        return held.promise;
      }

      return run(id, args, signal);
    });

    const changes = createChangeQueries(f.access, f.cli);
    const first = changes('fixture', f.initial, null, owner.signal).catch(
      (error: unknown) => error,
    );

    try {
      await entered.promise;
      owner.abort(reason);
      expect(await promptly(first)).toBe(reason);
      expect(readOwner?.aborted).toBe(true);
      expect(readOwner?.reason).toBe(reason);
      const next = await changes('fixture', f.initial, null);

      expect(next).toMatchObject([
        { status: 'added', oldPath: null, newPath: 'sample.txt' },
      ]);
      held.resolve(command === 'cat-file' ? 'tree fixture\n\nRoot\n' : '');
      await first;
      expect(await changes('fixture', f.initial, null)).toEqual(next);
    } finally {
      held.resolve(command === 'cat-file' ? 'tree fixture\n\nRoot\n' : '');
      await first;
      vi.restoreAllMocks();
      await f.dispose();
    }
  },
);

test('invalidation cancels subscribers and obsolete settlement cannot remove a pending successor', async () => {
  const f = await createSquashFixture();
  const entered = [deferred<void>(), deferred<void>()];
  const held = [deferred<void>(), deferred<void>()];
  const repo = f.access.repository('fixture');
  let comparisons = 0;

  repo.getCommit = async (hash) => ({ hash, parents: [], message: 'Parent' });
  repo.diffBetween = async () => {
    const index = comparisons++;

    entered[index]?.resolve();
    await held[index]?.promise;

    return [];
  };

  const changes = createChangeQueries(f.access, f.cli);
  const first = changes('fixture', f.c, f.b).catch((error: unknown) => error);

  try {
    await entered[0]!.promise;
    changes.invalidate('fixture');
    expect(await promptly(first)).toMatchObject({ name: 'AbortError' });
    const second = changes('fixture', f.c, f.b);

    await entered[1]!.promise;
    held[0]!.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const third = changes('fixture', f.c, f.b);

    held[1]!.resolve();
    await expect(second).resolves.toEqual([]);
    await expect(third).resolves.toEqual([]);
    expect(comparisons).toBe(2);
  } finally {
    held.forEach((read) => read.resolve());
    await first;
    await f.dispose();
  }
});

test('disposal releases pending native reads and rejects later callers', async () => {
  const f = await createSquashFixture();
  const entered = deferred<void>();
  const held = deferred<void>();
  const repo = f.access.repository('fixture');

  repo.getCommit = async (hash) => ({ hash, parents: [], message: 'Parent' });
  repo.diffBetween = async () => {
    entered.resolve();
    await held.promise;

    return [];
  };

  const changes = createChangeQueries(f.access, f.cli);
  const first = changes('fixture', f.c, f.b).catch((error: unknown) => error);

  try {
    await entered.promise;
    changes.dispose();
    changes.dispose();
    expect(await promptly(first)).toMatchObject({ name: 'AbortError' });
    await expect(changes('fixture', f.c, f.b)).rejects.toMatchObject({
      name: 'AbortError',
    });
  } finally {
    held.resolve();
    await first;
    await f.dispose();
  }
});

test.each(['pending', 'cached'])(
  'fresh same-root API wrappers preserve %s comparison sharing',
  async (stage) => {
    const f = await createSquashFixture();
    const entered = deferred<void>();
    const held = deferred<void>();
    const repo = f.access.repository('fixture');
    let reads = 0;

    repo.getCommit = async (hash) => ({ hash, parents: [], message: 'Parent' });
    repo.diffBetween = async () => {
      reads++;
      entered.resolve();
      if (stage === 'pending') await held.promise;

      return [];
    };

    f.access.repository = () => ({ ...repo });
    const changes = createChangeQueries(f.access, f.cli);
    const first = changes('fixture', f.c, f.b).catch((error: unknown) => error);

    try {
      await entered.promise;
      if (stage === 'cached') await first;
      const second = changes('fixture', f.c, f.b);

      held.resolve();
      await expect(first).resolves.toEqual([]);
      await expect(second).resolves.toEqual([]);
      await expect(changes('fixture', f.c, f.b)).resolves.toEqual([]);
      expect(reads).toBe(1);
    } finally {
      held.resolve();
      await first;
      await f.dispose();
    }
  },
);
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('already-cancelled callers retain their exact reason without starting work', async () => {
  const f = await createSquashFixture();
  const owner = new AbortController();
  const reason = new DOMException('The comparison expired.', 'TimeoutError');
  const changes = createChangeQueries(f.access, f.cli);
  const run = vi.spyOn(f.cli, 'run');

  try {
    owner.abort(reason);
    await expect(
      changes('fixture', f.initial, null, owner.signal),
    ).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled();
  } finally {
    changes.dispose();
    vi.restoreAllMocks();
    await f.dispose();
  }
});

test('native results from a closed repository cannot be published or retained', async () => {
  const f = await createSquashFixture();
  const entered = deferred<void>();
  const held = deferred<void>();
  const repo = f.access.repository('fixture');
  let reads = 0;

  repo.getCommit = async (hash) => ({ hash, parents: [], message: 'Parent' });
  repo.diffBetween = async () => {
    if (++reads === 1) {
      entered.resolve();
      await held.promise;
    }

    return [];
  };

  const changes = createChangeQueries(f.access, f.cli);
  const first = changes('fixture', f.c, f.b).catch((error: unknown) => error);

  try {
    await entered.promise;
    f.access.repository = () => {
      throw new Error('Repository is closed.');
    };

    held.resolve();
    expect(await first).toMatchObject({ message: 'Repository is closed.' });
    f.access.repository = () => repo;
    await expect(changes('fixture', f.c, f.b)).resolves.toEqual([]);
    expect(reads).toBe(2);
  } finally {
    changes.dispose();
    held.resolve();
    await first;
    await f.dispose();
  }
});

test('comparison validation retains raw shallow parents and explains missing objects', async () => {
  const f = await createSquashFixture();
  const repo = f.access.repository('fixture');
  const changes = createChangeQueries(f.access, f.cli);

  repo.getCommit = async () => {
    throw new Error('The shallow parent object is missing.');
  };

  try {
    await writeFile(join(f.root, '.git', 'shallow'), f.c + '\n');
    await expect(changes('fixture', f.c, null)).rejects.toThrow(
      'Select an actual parent comparison.',
    );
    await expect(changes('fixture', f.c, f.a)).rejects.toThrow(
      'Select an actual parent comparison.',
    );
    await expect(changes('fixture', f.c, f.b)).rejects.toThrow(
      'The parent object is unavailable, possibly in a shallow repository.',
    );
    await expect(changes('fixture', '0'.repeat(40), null)).rejects.toThrow(
      'The commit or parent object is unavailable.',
    );
  } finally {
    changes.dispose();
    await f.dispose();
  }
});
