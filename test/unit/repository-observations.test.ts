import assert from 'node:assert/strict';

import { expect, test, vi } from 'vitest';

import { createGitAdapter } from '../../src/extension/git/adapter';
import type { GitRef } from '../../src/extension/git/api';
import { deferred } from '../fixtures/deferred';

const host = vi.hoisted(() => ({
  refs: [] as GitRef[],
  listeners: new Set<() => void>(),
  openListeners: new Set<() => void>(),
  closeListeners: new Set<() => void>(),
  repositoryDisposals: 0,
  reads: 0,
  disposals: 0,
  read: async (): Promise<GitRef[]> => [],
}));

vi.mock('vscode', () => ({ window: {} }));
vi.mock('../../src/extension/git/cli', async () => {
  const { tmpdir } = await import('node:os');

  return {
    GitCli: class {
      async run() {
        return tmpdir();
      }
    },
  };
});
vi.mock('../../src/extension/git/api', () => ({
  getGitApi: async () => ({
    api: {
      git: { path: 'git' },
      onDidOpenRepository: (listener: () => void) => {
        host.openListeners.add(listener);

        return {
          dispose() {
            host.repositoryDisposals++;
            host.openListeners.delete(listener);
          },
        };
      },
      onDidCloseRepository: (listener: () => void) => {
        host.closeListeners.add(listener);

        return {
          dispose() {
            host.repositoryDisposals++;
            host.closeListeners.delete(listener);
          },
        };
      },
    },
    repository: () => ({
      fetch: async () => {},
      status: async () => {},
      state: {
        HEAD: undefined,
        worktrees: [],
        remotes: [],
        onDidChange: (listener: () => void) => {
          host.listeners.add(listener);

          return {
            dispose() {
              host.disposals++;
              host.listeners.delete(listener);
            },
          };
        },
      },
      getRefs: async () => {
        host.reads++;

        return host.read();
      },
    }),
    repositories: () => [],
  }),
}));

async function fixture() {
  host.refs = [];
  host.reads = 0;
  host.disposals = 0;
  host.listeners.clear();
  host.openListeners.clear();
  host.closeListeners.clear();
  host.repositoryDisposals = 0;
  host.read = async () => [...host.refs];

  return createGitAdapter();
}

test('repository consumers share one native listener and settled metadata read', async () => {
  const adapter = await fixture();
  let firstChanges = 0;
  let secondChanges = 0;
  const first = adapter.subscribe('fixture', () => firstChanges++);
  const second = adapter.subscribe('fixture', () => secondChanges++);

  try {
    expect(host.listeners.size).toBe(1);
    await vi.waitFor(() => expect(host.reads).toBe(1));
    host.refs = [{ type: 0, name: 'feature', commit: 'a'.repeat(40) }];
    for (const listener of host.listeners) listener();
    await vi.waitFor(() => expect(firstChanges).toBe(1));
    expect(secondChanges).toBe(1);
    first.dispose();
    expect(host.listeners.size).toBe(1);
    second.dispose();
    expect(host.listeners.size).toBe(0);
    adapter.dispose();
    expect(host.disposals).toBe(1);
  } finally {
    adapter.dispose();
  }
});

test('repository-list subscriptions stop notifying and release both native listeners once', async () => {
  const adapter = await fixture();
  let changes = 0;
  const subscription = adapter.subscribeRepositories(() => changes++);
  const opened = [...host.openListeners][0];
  const closed = [...host.closeListeners][0];

  try {
    assert.ok(opened && closed);
    opened();
    closed();
    expect(changes).toBe(2);
    subscription.dispose();
    subscription.dispose();
    opened();
    closed();
    expect(changes).toBe(2);
    expect(host.openListeners.size).toBe(0);
    expect(host.closeListeners.size).toBe(0);
    expect(host.repositoryDisposals).toBe(2);
    const current = adapter.subscribeRepositories(() => changes++);
    const late = [...host.openListeners][0];

    assert.ok(late);
    adapter.dispose();
    current.dispose();
    late();
    expect(changes).toBe(2);
    expect(host.repositoryDisposals).toBe(4);
    expect(() => adapter.subscribeRepositories(() => {})).toThrow('disposed');
    expect(() => adapter.subscribe('fixture', () => {})).toThrow('disposed');
  } finally {
    adapter.dispose();
  }
});

test('switching subscriptions releases old native listeners exactly once', async () => {
  const adapter = await fixture();

  try {
    for (let switchIndex = 0; switchIndex < 20; switchIndex++) {
      const subscription = adapter.subscribe('fixture', () => {});

      subscription.dispose();
      subscription.dispose();
    }

    expect(host.listeners.size).toBe(0);
    expect(host.disposals).toBe(20);
    const current = adapter.subscribe('fixture', () => {});

    adapter.dispose();
    current.dispose();
    expect(host.disposals).toBe(21);
    expect(host.listeners.size).toBe(0);
  } finally {
    adapter.dispose();
  }
});

test('disposing during a metadata read suppresses late notifications', async () => {
  const adapter = await fixture();
  const held = deferred<GitRef[]>();
  let changes = 0;
  const subscription = adapter.subscribe('fixture', () => changes++);

  try {
    await vi.waitFor(() => expect(host.reads).toBe(1));
    host.read = () => held.promise;
    for (const listener of host.listeners) listener();
    await vi.waitFor(() => expect(host.reads).toBe(2));
    subscription.dispose();
    held.resolve([{ type: 0, name: 'late', commit: 'b'.repeat(40) }]);
    await held.promise;
    expect(changes).toBe(0);
    expect(host.listeners.size).toBe(0);
  } finally {
    held.resolve([]);
    adapter.dispose();
  }
});

test('completed Git writes return while unrelated metadata observations are still pending', async (t) => {
  const adapter = await fixture();
  const held = deferred<GitRef[]>();

  host.read = () => held.promise;
  adapter.subscribe('fixture', () => {});
  t.onTestFinished(() => {
    held.resolve([]);
    adapter.dispose();
  });
  await vi.waitFor(() => expect(host.reads).toBe(1));
  let result: unknown;
  const pending = adapter
    .operate('fixture', { kind: 'fetch-all' })
    .then((value) => {
      result = value;
    });

  await vi.waitFor(() =>
    expect(result).toEqual({ kind: 'success', backend: 'api' }),
  );
  await pending;
});
