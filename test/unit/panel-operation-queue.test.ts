import { expect, test } from 'vitest';

import { PanelOperations } from '../../src/extension/panel/operation-progress';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

test('a failed queue publication cannot let later writes overtake a running action', async (t) => {
  const started = deferred();
  const release = deferred();
  const writes: string[] = [];
  let failed = false;
  const operations = new PanelOperations(async (message) => {
    if (message.body.operation?.queued?.length && !failed) {
      failed = true;
      throw new Error('Webview publication failed');
    }
  });
  const action = (key: string) =>
    operations.run({
      repositoryId: 'one',
      requestId: key,
      key,
      description: { label: key, refIds: [] },
      work: async () => {
        writes.push(key);
        if (key === 'first') {
          started.resolve();
          await release.promise;
        }
      },
    });
  const pending = [action('first')];

  t.onTestFinished(async () => {
    release.resolve();
    await Promise.allSettled(pending);
  });
  await started.promise;
  pending.push(action('second').catch(() => {}));
  await operations.run({
    repositoryId: 'one',
    requestId: 'copy',
    description: null,
    work: async () => {},
  });
  pending.push(action('third'));
  await operations.run({
    repositoryId: 'one',
    requestId: 'copy',
    description: null,
    work: async () => {},
  });
  expect(writes).toEqual(['first']);
  release.resolve();
  await Promise.all(pending);
  expect(writes).toEqual(['first', 'second', 'third']);
});

test('a delayed final publication cannot clear a subsequent native menu action', async (t) => {
  const clearing = deferred();
  const release = deferred();
  const writes: string[] = [];
  let clears = 0;
  const operations = new PanelOperations(async (message) => {
    if (message.body.operation === null && ++clears === 1) {
      clearing.resolve();
      await release.promise;
    }
  });
  const action = (key: string) =>
    operations.run({
      repositoryId: 'one',
      requestId: 'branch-menu',
      key,
      description: { label: key, refIds: [] },
      work: async () => {
        writes.push(key);
      },
    });
  const first = action('first');
  const pending = [first];

  t.onTestFinished(async () => {
    release.resolve();
    await Promise.allSettled(pending);
  });
  await clearing.promise;
  pending.push(action('second'));
  // Finish another independently queued read to yield the promise microtasks.
  await operations.run({
    repositoryId: 'one',
    requestId: 'copy',
    description: null,
    work: async () => {},
  });
  expect(writes).toEqual(['first']);
  release.resolve();
  await Promise.all(pending);
  expect(writes).toEqual(['first', 'second']);
});

test('an independent update cannot be cleared by a delayed older native-menu completion', async (t) => {
  const clearing = deferred();
  const releasePublication = deferred();
  const releaseWrite = deferred();
  const messages: string[] = [];
  const operations = new PanelOperations(async (message) => {
    if (message.body.operation === null && !messages.includes('finished')) {
      clearing.resolve();
      await releasePublication.promise;
    }

    messages.push(message.body.operation?.label ?? 'finished');
  });
  const first = operations.run({
    repositoryId: 'one',
    requestId: 'branch-menu',
    key: 'first',
    independent: true,
    description: { label: 'first', refIds: [] },
    work: async (progress) => {
      await progress.refreshing();
    },
  });
  const pending = [first];

  t.onTestFinished(async () => {
    releasePublication.resolve();
    releaseWrite.resolve();
    await Promise.allSettled(pending);
  });
  await clearing.promise;
  pending.push(
    operations.run({
      repositoryId: 'one',
      requestId: 'branch-menu',
      key: 'second',
      independent: true,
      description: { label: 'second', refIds: [] },
      work: async () => {
        await releaseWrite.promise;
      },
    }),
  );
  // Yield reads without waiting for either write's view lifecycle.
  await operations.run({
    repositoryId: 'one',
    requestId: 'read',
    description: null,
    work: async () => {},
  });
  releasePublication.resolve();
  await first;
  await operations.run({
    repositoryId: 'one',
    requestId: 'read',
    description: null,
    work: async () => {},
  });
  expect(messages.at(-1)).toBe('second');
});
