import { expect, test } from 'vitest';

import type { GitApiInitialization } from '../../src/extension/git/api-initialization';
import { waitForGitInitialization } from '../../src/extension/git/api-initialization';

function fixture(state: GitApiInitialization['state']) {
  const listeners = new Set<(state: GitApiInitialization['state']) => void>();
  const repositories = ['primary'];
  let subscriptions = 0;
  let disposals = 0;
  const api: GitApiInitialization = {
    state,
    onDidChangeState(listener) {
      subscriptions++;
      listeners.add(listener);

      return {
        dispose() {
          if (listeners.delete(listener)) disposals++;
        },
      };
    },
  };
  const changeState = (state: GitApiInitialization['state']) => {
    Object.assign(api, { state });
    for (const listener of listeners) listener(state);
  };

  return {
    api,
    repositories,
    changeState,
    listeners,
    counts: () => ({ subscriptions, disposals }),
  };
}

test('Git access waits for initial discovery to finish before consuming repositories', async () => {
  const f = fixture('uninitialized');
  let discovered: string[] | null = null;
  const access = waitForGitInitialization(f.api).then(() => {
    discovered = [...f.repositories];
  });

  await Promise.resolve();
  expect(discovered).toBe(null);
  f.changeState('uninitialized');
  await Promise.resolve();
  expect(discovered).toBe(null);
  f.repositories.push('secondary');
  f.changeState('initialized');
  await access;
  expect(discovered).toStrictEqual(['primary', 'secondary']);
  expect(f.listeners.size).toBe(0);
  expect(f.counts()).toStrictEqual({ subscriptions: 1, disposals: 1 });
});
test('an initialized API is immediately available without retaining a listener', async () => {
  const f = fixture('initialized');

  await waitForGitInitialization(f.api);
  expect(f.listeners.size).toBe(0);
  expect(f.counts()).toStrictEqual({ subscriptions: 0, disposals: 0 });
});

test('cancelling discovery settles the wait and removes its listener before initialization', async () => {
  const f = fixture('uninitialized');
  const owner = new AbortController();
  const reason = new Error('The view closed.');
  const wait = waitForGitInitialization(f.api, owner.signal);
  const settled = wait.then(
    () => ({ kind: 'ready' }),
    (error: unknown) => ({ kind: 'cancelled', error }),
  );

  try {
    owner.abort(reason);
    expect(f.listeners.size).toBe(0);
    expect(await settled).toEqual({ kind: 'cancelled', error: reason });
    f.changeState('initialized');
    expect(f.counts()).toStrictEqual({ subscriptions: 1, disposals: 1 });
  } finally {
    f.changeState('initialized');
    await settled;
  }
});

test('discovery normalizes a non-Error cancellation reason to an AbortError', async () => {
  const f = fixture('uninitialized');
  const owner = new AbortController();
  const settled = waitForGitInitialization(f.api, owner.signal).catch(
    (error: unknown) => error,
  );

  owner.abort('The view closed.');
  expect(await settled).toBeInstanceOf(DOMException);
  expect(await settled).toMatchObject({ name: 'AbortError' });
  expect(f.listeners.size).toBe(0);
});
