import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';

import type { GitApiInitialization } from '../../src/extension/git/api-initialization';
import { SourceControlService } from '../../src/extension/source-control/service';
import type { SourceControlState } from '../../src/shared/source-control';

const host = vi.hoisted(() => {
  const errors: string[] = [];
  const listeners = new Set<(state: GitApiInitialization['state']) => void>();
  let state: GitApiInitialization['state'] = 'uninitialized';
  let activation: Promise<void> = Promise.resolve();
  let activationCount = 0;
  let repositorySubscriptions = 0;
  const subscribeRepository = () => {
    repositorySubscriptions++;

    return { dispose() {} };
  };

  const api = {
    get state() {
      return state;
    },
    repositories: [],
    git: { path: 'git' },
    onDidChangeState(listener: (state: GitApiInitialization['state']) => void) {
      listeners.add(listener);

      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
    onDidOpenRepository: subscribeRepository,
    onDidCloseRepository: subscribeRepository,
  };

  return {
    api,
    errors,
    listeners,
    activate() {
      activationCount++;

      return activation;
    },
    get activationCount() {
      return activationCount;
    },
    get repositorySubscriptions() {
      return repositorySubscriptions;
    },
    holdActivation() {
      let release = () => {};

      activation = new Promise<void>((resolve) => {
        release = resolve;
      });

      return release;
    },
    initialize() {
      state = 'initialized';
      for (const listener of listeners) listener(state);
    },
    reset() {
      state = 'uninitialized';
      activation = Promise.resolve();
      activationCount = 0;
      repositorySubscriptions = 0;
      errors.length = 0;
      listeners.clear();
    },
  };
});

vi.mock('vscode', () => {
  const event = () => ({ dispose() {} });

  return {
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
      onDidGrantWorkspaceTrust: event,
      onDidChangeConfiguration: event,
      onDidChangeWorkspaceFolders: event,
      onDidChangeTextDocument: event,
    },
    window: {
      showErrorMessage: async (message: string) => {
        host.errors.push(message);
      },
    },
    extensions: {
      onDidChange: event,
      getExtension: () => ({
        activate: host.activate,
        exports: { enabled: true, getAPI: () => host.api },
      }),
    },
    commands: { executeCommand: async () => {} },
  };
});

function fixture(holdActivation = false) {
  host.reset();
  const release = holdActivation ? host.holdActivation() : () => {};

  const published: SourceControlState[] = [];

  function get<T>(key: string): T | undefined;
  function get<T>(key: string, defaultValue: T): T;
  function get<T>(...args: [string, T?]): T | undefined {
    return args[1];
  }

  const storage: vscode.Memento = {
    get,
    keys: () => [],
    update: async () => {},
  };
  const service = new SourceControlService(storage, (state) =>
    published.push(state),
  );

  return { service, published, release };
}

afterEach(() => {
  host.initialize();
});

test('disposing Source Control during discovery removes its listener and settles the refresh', async (t) => {
  const f = fixture();
  const refresh = f.service.refresh();

  t.onTestFinished(() => f.service.dispose());
  await vi.waitFor(() => expect(host.listeners.size).toBe(1));
  const published = f.published.length;

  f.service.dispose();
  expect(host.listeners.size).toBe(0);
  await refresh;
  host.initialize();
  await delay(0);
  expect(host.repositorySubscriptions).toBe(0);
  expect(host.errors).toEqual([]);
  expect(f.published).toHaveLength(published);
});

test('disposing Source Control abandons activation and prevents a late discovery listener', async (t) => {
  const f = fixture(true);
  const refresh = f.service.refresh();

  t.onTestFinished(() => {
    f.release();
    f.service.dispose();
  });
  await vi.waitFor(() => expect(host.activationCount).toBe(1));
  const published = f.published.length;

  f.service.dispose();
  const settled = await Promise.race([
    refresh.then(() => true),
    delay(500).then(() => false),
  ]);

  f.release();
  await delay(0);
  expect(host.listeners.size).toBe(0);
  expect(settled).toBe(true);
  expect(host.repositorySubscriptions).toBe(0);
  expect(host.errors).toEqual([]);
  expect(f.published).toHaveLength(published);
});
