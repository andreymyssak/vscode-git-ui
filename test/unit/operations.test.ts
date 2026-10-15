import { tmpdir } from 'node:os';

import { expect, test, vi } from 'vitest';

import type {
  GitAPI,
  GitApiAccess,
  GitRepository,
} from '../../src/extension/git/api';
import {
  createOperations,
  OperationQueue,
} from '../../src/extension/git/operations';
import { deferred } from '../fixtures/deferred';

test('an operation waiting for the shared Git lock reports waiting before running', async (t) => {
  const held = deferred<void>();
  let fetches = 0;
  const repo = {
    fetch: async () => {
      if (++fetches === 1) await held.promise;
    },
    status: async () => {},
  } as unknown as GitRepository;
  const access: GitApiAccess = {
    api: {} as GitAPI,
    repository: () => repo,
    repositories: () => [],
  };
  const run = createOperations(
    access,
    { run: async () => tmpdir() },
    { remoteCheckout: async () => null },
  );
  const first = run('waiting-operation', { kind: 'fetch-all' });

  await vi.waitFor(() => expect(fetches).toBe(1));
  const phases: string[] = [];
  const second = run(
    'waiting-operation',
    { kind: 'fetch-all' },
    undefined,
    async (phase) => {
      phases.push(phase);
    },
  );

  t.onTestFinished(async () => {
    held.resolve();
    await Promise.allSettled([first, second]);
  });
  await vi.waitFor(() => expect(phases).toEqual(['waiting']));
  expect(fetches).toBe(1);
  held.resolve();
  await Promise.all([first, second]);
  expect(phases).toEqual(['waiting', 'running']);
});

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
