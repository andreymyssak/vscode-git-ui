import { tmpdir } from 'node:os';

import { expect, test } from 'vitest';

import type {
  GitAPI,
  GitApiAccess,
  GitRepository,
} from '../../src/extension/git/api';
import {
  createOperations,
  OperationQueue,
} from '../../src/extension/git/operations';

test('an edit queued behind another operation performs no write after its view is cancelled', async (t) => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sha = 'a'.repeat(40);
  const writes: string[] = [];
  const repo = {
    fetch: () => wait,
    status: async () => {},
    getCommit: async () => ({ hash: sha }),
  } as unknown as GitRepository;
  const access: GitApiAccess = {
    api: {} as GitAPI,
    repository: () => repo,
    repositories: () => [],
  };
  const run = createOperations(
    access,
    {
      run: async (_id, args) => {
        if (args.includes('--git-common-dir')) return tmpdir();
        if (args[0] === 'commit') writes.push('commit');

        return args[0] === 'symbolic-ref' ? 'main\n' : '';
      },
    },
    { updateDiverged: async () => null, remoteCheckout: async () => null },
  );
  const first = run('one', { kind: 'fetch-all' });
  const view = new AbortController();
  const edit = run(
    'one',
    {
      kind: 'edit-commit-message',
      expectedHeadSha: sha,
      sha,
      expectedBranch: 'main',
      message: 'Edited',
    },
    view.signal,
  );

  t.onTestFinished(async () => {
    release();
    await Promise.allSettled([first, edit]);
  });
  view.abort();
  release();
  await first;
  expect((await edit).kind).toBe('cancelled');
  expect(writes).toStrictEqual([]);
});
test('writes serialize per repository while other repositories remain independent', async (t) => {
  const queue = new OperationQueue();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const first = queue.run('one', async () => {
    events.push('first');
    await wait;

    return { kind: 'success', backend: 'api' };
  });
  const second = queue.run('one', async () => {
    events.push('second');

    return { kind: 'success', backend: 'api' };
  });

  t.onTestFinished(async () => {
    release();
    await Promise.allSettled([first, second]);
  });
  await queue.run('two', async () => {
    events.push('other');

    return { kind: 'success', backend: 'api' };
  });
  expect(events).toStrictEqual(['first', 'other']);
  release();
  await Promise.all([first, second]);
  expect(events).toStrictEqual(['first', 'other', 'second']);
});
