import { expect, test, vi } from 'vitest';

import type { HistoryShallow } from '../../src/extension/git/history-shallow';
import { watchHistoryShallow } from '../../src/extension/native/history-shallow-watch';
import { deferred } from '../fixtures/deferred';

const host = vi.hoisted(() => ({
  created: [] as { root: string; pattern: string }[],
  callbacks: [] as (() => void)[],
  disposals: 0,
}));

vi.mock('vscode', () => ({
  Uri: { file: (path: string) => ({ fsPath: path }) },
  RelativePattern: class {
    constructor(
      public root: { fsPath: string },
      public pattern: string,
    ) {}
  },
  workspace: {
    createFileSystemWatcher: (pattern: {
      root: { fsPath: string };
      pattern: string;
    }) => {
      host.created.push({
        root: pattern.root.fsPath,
        pattern: pattern.pattern,
      });
      const register = (callback: () => void) => {
        host.callbacks.push(callback);

        return { dispose() {} };
      };

      return {
        onDidCreate: register,
        onDidChange: register,
        onDidDelete: register,
        dispose() {
          host.disposals++;
        },
      };
    },
  },
}));

function reader(path: () => Promise<string>): HistoryShallow {
  return {
    path,
    identity: async () => 'complete',
    invalidate() {},
    dispose() {},
  };
}

test('a nonrecursive shared-metadata watcher handles creation, changes and removal and releases ownership', async () => {
  host.created = [];
  host.callbacks = [];
  host.disposals = 0;
  let changes = 0;
  const watcher = watchHistoryShallow(
    reader(async () => '/shared-git/shallow'),
    'one',
    () => {
      changes++;
    },
  );

  await vi.waitFor(() =>
    expect(host.created).toEqual([{ root: '/shared-git', pattern: 'shallow' }]),
  );
  expect(changes).toBe(1);
  for (const callback of host.callbacks) callback();
  expect(changes).toBe(4);
  watcher.dispose();
  expect(host.disposals).toBe(1);
});

test('closing during path discovery cannot install an orphan shallow watcher', async () => {
  host.created = [];
  const path = deferred<string>();
  const watcher = watchHistoryShallow(
    reader(() => path.promise),
    'one',
    () => {},
  );

  watcher.dispose();
  path.resolve('/shared-git/shallow');
  await path.promise;
  await Promise.resolve();
  expect(host.created).toEqual([]);
});
