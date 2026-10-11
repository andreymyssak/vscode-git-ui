import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import type { GitApiAccess } from '../../src/extension/git/api';
import { createOperations } from '../../src/extension/git/operations';

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const head = 'c'.repeat(40);

test('multi-pick writes once in captured order and cancels at the final boundary', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'git-ui-native-pick-unit-'));

  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const writes: readonly string[][] = [];
  const access = {
    repository: () => ({
      getCommit: async (sha: string) => ({
        hash: sha === 'HEAD' ? head : sha,
        parents: [head],
      }),
      status: async () => {},
    }),
  } as unknown as GitApiAccess;
  const context = new AbortController();
  let cancel = false;
  const operate = createOperations(
    access,
    {
      run: async (_id, args, _signal, before) => {
        if (args.includes('--git-common-dir')) return directory;
        if (args[0] === 'symbolic-ref') return 'main\n';
        if (args[0] === 'rev-parse') return join(directory, args.at(-1)!);
        if (args[0] === 'cherry-pick') {
          if (cancel) context.abort();
          await before?.();
          (writes as string[][]).push([...args]);
        }

        return '';
      },
    },
    { updateDiverged: async () => null, remoteCheckout: async () => null },
  );
  const action = {
    kind: 'cherry-pick-commits' as const,
    target: { shas: [a, b], expectedHeadSha: head, expectedBranch: 'main' },
  };

  try {
    expect((await operate('repo', action)).kind).toBe('success');
    expect(writes).toStrictEqual([['cherry-pick', a, b]]);
    cancel = true;
    expect((await operate('repo', action, context.signal)).kind).toBe(
      'cancelled',
    );
    expect(writes.length).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
