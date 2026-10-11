import { tmpdir } from 'node:os';

import { expect, test } from 'vitest';

import { repositoryOperations } from '../../src/extension/git/operations';
import { withRepositoryOperation } from '../../src/extension/git/repository-operations';

test('native writes wait for an existing Log write to the same repository', async (t) => {
  const events: string[] = [];
  let release = () => {};

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = repositoryOperations.run('native-log', async () => {
    events.push('log');
    await held;
  });

  t.onTestFinished(async () => {
    release();
    await first;
  });
  const second = withRepositoryOperation(
    { run: async () => tmpdir() },
    'native-log',
    async () => {
      events.push('native');

      return 42;
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toEqual(['log']);
  release();
  await first;
  expect(await second).toBe(42);
  expect(events).toEqual(['log', 'native']);
});

test('native writes in linked worktrees share a lock and release it after failure', async (t) => {
  const events: string[] = [];
  let release = () => {};

  let started = () => {};

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cli = { run: async () => tmpdir() };
  const first = withRepositoryOperation(cli, 'linked-one', async () => {
    events.push('one');
    started();
    await held;
    throw new Error('write failed');
  });
  const caught = first.catch((error: unknown) => error);

  t.onTestFinished(async () => {
    release();
    await caught;
  });
  await entered;
  const second = withRepositoryOperation(cli, 'linked-two', async () => {
    events.push('two');

    return 'done';
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toEqual(['one']);
  release();
  expect(await caught).toBeInstanceOf(Error);
  expect(await second).toBe('done');
  expect(events).toEqual(['one', 'two']);
});
