import { expect, test } from 'vitest';

import type { GitRef } from '../../src/extension/git/api';
import { historyChangeFilter } from '../../src/extension/git/history-events';
import { deferred } from '../fixtures/deferred';

test('history status filtering uses live references and ignores reordered, unchanged metadata', async () => {
  const head = { type: 0 as const, name: 'main', commit: 'a'.repeat(40) };
  const tag = { type: 2 as const, name: 'v1', commit: head.commit };
  let refs: GitRef[] = [head, tag];
  let failed = false;
  const state = { HEAD: head, worktrees: [], remotes: [] };
  const repository = {
    state,
    getRefs: async () => {
      if (failed) throw new Error('Reference lookup failed');

      return [...refs];
    },
  };
  let changes = 0;
  const observation = historyChangeFilter(repository, () => {
    changes++;
  });
  const notify = () => observation.check();

  await notify();
  refs = [tag, head];
  await notify();
  expect(changes).toBe(0);
  refs = [...refs, { ...head, name: 'feature' }];
  await notify();
  expect(changes, 'a branch at the same HEAD must refresh history').toBe(1);
  await notify();
  expect(changes).toBe(1);
  state.HEAD = { ...head, name: 'feature' };
  await notify();
  expect(changes, 'checkout at the same commit must refresh history').toBe(2);
  failed = true;
  await notify();
  expect(changes, 'a failed metadata read must invalidate conservatively').toBe(
    3,
  );
  failed = false;
  await notify();
  await notify();
  expect(changes, 'a successful read reestablishes the baseline').toBe(4);
});

test('a burst of unchanged status events shares one fresh reference snapshot', async () => {
  let reads = 0;
  const observation = historyChangeFilter(
    {
      state: { HEAD: undefined, worktrees: [], remotes: [] },
      getRefs: async () => {
        reads++;

        return [];
      },
    },
    () => {
      throw new Error('Unchanged metadata must not notify');
    },
  );

  await observation.settled();
  await Promise.all(Array.from({ length: 100 }, () => observation.check()));
  expect(reads).toBe(2);
});

test('events during an active read take a final fresh snapshot before settling', async () => {
  const held = deferred<GitRef[]>();
  const started = deferred<void>();
  let refs: GitRef[] = [];
  let reads = 0;
  let changes = 0;
  const observation = historyChangeFilter(
    {
      state: { HEAD: undefined, worktrees: [], remotes: [] },
      getRefs: async () => {
        reads++;
        if (reads === 2) {
          started.resolve();

          return held.promise;
        }

        return [...refs];
      },
    },
    () => {
      changes++;
    },
  );

  await observation.settled();
  const first = observation.check();

  await started.promise;
  refs = [{ type: 0, name: 'feature', commit: 'a'.repeat(40) }];
  const events = Array.from({ length: 20 }, () => observation.check());
  let settled = false;
  const barrier = observation.settled().then(() => {
    settled = true;
  });

  await Promise.resolve();
  expect(settled).toBe(false);
  held.resolve([]);
  await Promise.all([first, ...events, barrier]);
  expect(reads).toBe(3);
  expect(changes).toBe(1);
});

test('shallow ancestry changes invalidate history even with identical reference tips', async () => {
  let shallow = 'one-boundary';
  let changes = 0;
  const observation = historyChangeFilter(
    {
      state: { HEAD: undefined, worktrees: [], remotes: [] },
      getRefs: async () => [],
    },
    () => {
      changes++;
    },
    async () => shallow,
  );

  try {
    await observation.settled();
    shallow = 'complete';
    await observation.check();
    expect(changes).toBe(1);
    await observation.check();
    expect(changes).toBe(1);
  } finally {
    observation.dispose();
  }
});
