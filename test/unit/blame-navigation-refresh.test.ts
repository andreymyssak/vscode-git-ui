import { expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';

import { registerBlame } from '../../src/extension/native/blame-commands';
import { showOperationError } from '../../src/extension/native/operation-feedback';
import { commandId } from '../../src/shared/extension-identity';
import { b, fixture, page } from '../fixtures/controller';

const host = vi.hoisted(() => {
  const reports: string[] = [];

  return { commands: new Map<string, (value: unknown) => unknown>(), reports };
});

vi.mock('../../src/extension/git/api', () => ({
  getGitApi: async () => ({
    api: {
      getRepository: () => ({ rootUri: { toString: () => 'one' } }),
    },
    repository: () => ({ getCommit: async () => ({}) }),
  }),
}));

vi.mock('vscode', () => {
  class Disposable {
    constructor(private readonly release = () => {}) {}
    dispose() {
      this.release();
    }
  }

  return {
    Disposable,
    Uri: { parse: () => ({ scheme: 'file' }) },
    commands: {
      registerCommand(name: string, handler: (value: unknown) => unknown) {
        host.commands.set(name, handler);

        return new Disposable(() => host.commands.delete(name));
      },
      executeCommand: async () => {},
    },
    workspace: { onDidChangeConfiguration: () => new Disposable() },
    window: {
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: () => new Disposable(),
      showErrorMessage: async (message: string) => {
        host.reports.push(message);
      },
    },
    languages: { registerHoverProvider: () => new Disposable() },
  };
});

test('a paused Blame command returns false while its failed refresh reports once', async (t) => {
  host.commands.clear();
  host.reports.length = 0;
  const f = fixture(true, true, { reportActionError: showOperationError });
  const subscriptions: vscode.Disposable[] = [];
  let entered = () => {};

  let release = () => {};

  const resolving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  t.onTestFinished(() => {
    release();
    f.controller.dispose();
    for (const subscription of subscriptions) subscription.dispose();
  });
  await f.controller.selectRepository('one');
  f.adapter.resolve = async (_id, _input, signal) => {
    entered();
    await gate;
    signal?.throwIfAborted();

    return { kind: 'commit', commit: page([b]).commits[0]! };
  };

  registerBlame(
    { subscriptions },
    {
      revealCommit: (target, current) =>
        f.controller.revealCommit(target, current),
    },
  );
  const command = host.commands.get(commandId('open-blame-commit'));

  expect(command).toBeDefined();
  const pending = Promise.resolve(
    command?.({
      documentUri: 'file:///fixture/one/sample.txt',
      sha: b,
    }),
  );

  await resolving;
  f.adapter.history = async () => {
    throw new Error('Fresh metadata unavailable');
  };

  f.fireHistoryEvent();
  release();
  expect(await pending).toBe(false);
  expect(host.reports).toEqual(['Fresh metadata unavailable']);
  expect(f.sent.filter(({ body }) => body.kind === 'reveal')).toEqual([]);
  expect(f.writes).toEqual([]);
});
