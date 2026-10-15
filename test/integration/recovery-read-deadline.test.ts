import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, vi } from 'vitest';

import { validateSquash } from '../../src/extension/git/squash';
import { SquashRecovery } from '../../src/extension/git/squash-recovery';
import { deferred } from '../fixtures/deferred';
import { createSquashFixture } from '../fixtures/squash-repository';

test.each(['--show-toplevel', 'rebase-merge', 'rebase-apply'])(
  'a stalled recovery %s identity read expires and retains owned recovery bytes',
  async (heldArgument) => {
    const fixture = await createSquashFixture();
    const held = deferred<string>();
    const entered = deferred<void>();
    let scan: Promise<void> | undefined;
    let heldOutput = '';

    try {
      const storage = join(fixture.directory, 'storage');
      const recovery = new SquashRecovery(storage, fixture.cli);
      const snapshot = await validateSquash(
        fixture.access,
        fixture.cli,
        'fixture',
        fixture.target,
      );
      const owned = await recovery.create(
        'fixture',
        snapshot,
        'Retained draft',
      );

      // Observe a real native operation so terminal state would normally permit cleanup.
      await expect(
        fixture.runGit([
          'rebase',
          '--force-rebase',
          '--exec',
          'false',
          fixture.initial,
        ]),
      ).rejects.toThrow();
      await recovery.settle('fixture', owned.directory);
      await fixture.runGit(['rebase', '--abort']);
      const recordPath = join(owned.directory, 'record.json');
      const record = await readFile(recordPath, 'utf8');
      const input = await readFile(owned.inputPath, 'utf8');
      let owner: AbortSignal | undefined;
      let finished = false;
      const reopened = new SquashRecovery(storage, {
        run: async (id, args, signal) => {
          if (args.includes(heldArgument)) {
            heldOutput = await fixture.cli.run(id, args, signal);
            owner = signal;
            entered.resolve();

            return held.promise;
          }

          return fixture.cli.run(id, args, signal);
        },
      });

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      scan = reopened.reconcile().then(() => {
        finished = true;
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(119_999);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);
      expect(owner?.aborted).toBe(true);
      expect(owner?.reason).toMatchObject({ name: 'TimeoutError' });
      expect(vi.getTimerCount()).toBe(0);
      await scan;
      expect(await readFile(recordPath, 'utf8')).toBe(record);
      expect(await readFile(owned.inputPath, 'utf8')).toBe(input);
      held.resolve(heldOutput);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await readFile(recordPath, 'utf8')).toBe(record);
      expect(await readFile(owned.inputPath, 'utf8')).toBe(input);
    } finally {
      held.resolve(heldOutput);
      vi.useRealTimers();
      await scan;
      await fixture.dispose();
    }
  },
);

test('recovery creation keeps awaiting its message object write after the read deadline', async () => {
  const fixture = await createSquashFixture();
  const held = deferred<string>();
  const entered = deferred<void>();
  let creation: Promise<{ directory: string; inputPath: string }> | undefined;
  let heldOutput = '';

  try {
    const snapshot = await validateSquash(
      fixture.access,
      fixture.cli,
      'fixture',
      fixture.target,
    );
    let writeOwner: AbortSignal | undefined;
    let finished = false;
    const recovery = new SquashRecovery(join(fixture.directory, 'storage'), {
      run: async (id, args, signal) => {
        const output = await fixture.cli.run(id, args, signal);

        if (args.includes('commit-tree')) {
          heldOutput = output;
          writeOwner = signal;
          entered.resolve();

          return held.promise;
        }

        return output;
      },
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    creation = recovery
      .create('fixture', snapshot, 'Reviewed write')
      .then((owned) => {
        finished = true;

        return owned;
      });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(finished).toBe(false);
    expect(writeOwner).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    held.resolve(heldOutput);
    const owned = await creation;

    expect(await readFile(join(owned.directory, 'message.txt'), 'utf8')).toBe(
      'Reviewed write',
    );
  } finally {
    held.resolve(heldOutput);
    vi.useRealTimers();
    await creation;
    await fixture.dispose();
  }
});
