import { setTimeout as delay } from 'node:timers/promises';

import { expect, test, vi } from 'vitest';
import * as vscode from 'vscode';

import { SourceControlService } from '../../src/extension/source-control/service';
import type { WorkingFile } from '../../src/shared/source-control';

const host = vi.hoisted(() => {
  const dispose = () => {};

  const event = () => ({ dispose });
  const workingChanges = vi.fn<() => Promise<WorkingFile[]>>(async () => []);
  const backend = {
    dispose,
    repositories: () => [
      {
        id: 'file:///repo',
        rootUri: 'file:///repo',
        label: 'repo',
        branch: 'main',
        headSha: 'a'.repeat(40),
      },
    ],
    root: () => ({ fsPath: '/repo' }),
    subscribeRepositories: event,
    subscribe: event,
    workingChanges,
    stashes: async () => [],
    operation: async () => [],
    status: async () => {},
    repositoryAction: async () => {},
  };

  return { backend, event, workingChanges };
});

vi.mock('../../src/extension/git/source-control/index', () => ({
  createSourceControlBackend: async () => host.backend,
}));
vi.mock('vscode', () => ({
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
    }),
    onDidGrantWorkspaceTrust: host.event,
    onDidChangeConfiguration: host.event,
    onDidChangeWorkspaceFolders: host.event,
    onDidChangeTextDocument: host.event,
  },
  extensions: { onDidChange: host.event },
  commands: { executeCommand: async () => {} },
  Uri: { parse: () => ({ fsPath: '/repo' }) },
  ProgressLocation: { SourceControl: 1 },
  window: {
    withProgress: async (_options: unknown, work: () => Promise<void>) =>
      work(),
  },
}));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

test('native repository actions wait for the busy toolbar context before opening their picker', async (t) => {
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
  const service = new SourceControlService(storage, () => {});
  const pending = deferred<void>();

  await service.refresh();
  const native = vi.spyOn(host.backend, 'repositoryAction');
  const context = vi
    .spyOn(vscode.commands, 'executeCommand')
    .mockImplementation(async (command, ...args: unknown[]) => {
      if (
        command === 'setContext' &&
        args[0] === 'gitUI.sourceControlBusy' &&
        args[1] === true
      )
        await pending.promise;

      return undefined;
    });

  t.onTestFinished(() => {
    pending.resolve();
    context.mockRestore();
    native.mockRestore();
    service.dispose();
  });
  const action = service.handle({
    kind: 'fetch',
    repositoryId: 'file:///repo',
  });

  await delay(0);
  expect(context).toHaveBeenCalledWith(
    'setContext',
    'gitUI.sourceControlBusy',
    true,
  );
  expect(native).not.toHaveBeenCalled();
  expect(service.model.busy).toBe(true);
  await service.handle({ kind: 'pull', repositoryId: 'file:///repo' });
  expect(native).not.toHaveBeenCalled();
  pending.resolve();
  await action;
  expect(native).toHaveBeenCalledTimes(1);
  expect(service.model.busy).toBe(false);
});

test('repository writes remain busy until a superseding status refresh completes', async (t) => {
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
  const service = new SourceControlService(storage, () => {});
  const old = deferred<WorkingFile[]>();
  const latest = deferred<WorkingFile[]>();

  t.onTestFinished(() => {
    old.resolve([]);
    latest.resolve([]);
    service.dispose();
  });
  await service.refresh();
  const before = host.workingChanges.mock.calls.length;

  host.workingChanges
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(latest.promise);
  const action = service.handle({
    kind: 'fetch',
    repositoryId: 'file:///repo',
  });

  await vi.waitFor(() =>
    expect(host.workingChanges).toHaveBeenCalledTimes(before + 1),
  );
  const refresh = service.refresh();

  await vi.waitFor(() =>
    expect(host.workingChanges).toHaveBeenCalledTimes(before + 2),
  );
  old.resolve([]);
  // Flush the resolved read and command completion through the event loop.
  await delay(0);
  expect(service.model.busy).toBe(true);
  latest.resolve([
    {
      path: 'new.txt',
      originalPath: 'new.txt',
      status: 'untracked',
      staged: false,
      working: true,
      untracked: true,
    },
  ]);
  await Promise.all([action, refresh]);
  expect(service.model.busy).toBe(false);
  expect(service.model.requireRepository('file:///repo').changes).toEqual({
    kind: 'ready',
    items: [expect.objectContaining({ path: 'new.txt', status: 'untracked' })],
  });
});
