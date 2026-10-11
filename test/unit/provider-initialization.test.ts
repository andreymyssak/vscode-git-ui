import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';

import type { GitApiInitialization } from '../../src/extension/git/api-initialization';
import { GitViewProvider } from '../../src/extension/panel/provider';

const host = vi.hoisted(() => {
  type Configuration = {
    affectsConfiguration(section: string): boolean;
  };

  const errors: string[] = [];
  const listeners = new Set<(state: GitApiInitialization['state']) => void>();
  const configuration = new Set<(event: Configuration) => void>();
  let state: GitApiInitialization['state'] = 'uninitialized';
  let activation: Promise<void> = Promise.resolve();
  let activationCount = 0;
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
    onDidOpenRepository: () => ({ dispose() {} }),
    onDidCloseRepository: () => ({ dispose() {} }),
  };

  return {
    api,
    errors,
    listeners,
    configuration,
    activate() {
      activationCount++;

      return activation;
    },
    get activationCount() {
      return activationCount;
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
      errors.length = 0;
      listeners.clear();
      configuration.clear();
    },
  };
});

vi.mock('../../src/extension/panel/file-icon-host', () => ({
  attachFileIcons: () => ({ ready() {}, dispose() {} }),
}));
vi.mock('vscode', async () => {
  const { join: joinPath } = await import('node:path');
  const uri = (fsPath: string) => ({
    fsPath,
    scheme: 'file',
    toString: () => `file://${fsPath}`,
  });

  return {
    Uri: {
      file: uri,
      joinPath: (root: { fsPath: string }, ...parts: string[]) =>
        uri(joinPath(root.fsPath, ...parts)),
    },
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
      onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
      onDidChangeConfiguration: (
        listener: (event: {
          affectsConfiguration(section: string): boolean;
        }) => void,
      ) => {
        host.configuration.add(listener);

        return {
          dispose() {
            host.configuration.delete(listener);
          },
        };
      },
    },
    window: {
      activeTextEditor: undefined,
      showErrorMessage: async (message: string) => {
        host.errors.push(message);
      },
    },
    extensions: {
      getExtension: () => ({
        activate: host.activate,
        exports: { enabled: true, getAPI: () => host.api },
      }),
    },
    commands: { executeCommand: async () => {} },
  };
});

function fixture() {
  host.reset();
  const messages = new Set<(message: unknown) => unknown>();
  const delivered: unknown[] = [];
  const view: vscode.WebviewView = {
    viewType: 'gitUI.log',
    visible: true,
    title: 'Log',
    webview: {
      html: '',
      options: {},
      cspSource: 'test',
      asWebviewUri: (uri) => uri,
      postMessage: async (message: unknown) => {
        delivered.push(message);

        return true;
      },
      onDidReceiveMessage: (listener) => {
        messages.add(listener);

        return {
          dispose() {
            messages.delete(listener);
          },
        };
      },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
    show() {},
  };
  const provider = new GitViewProvider(
    vscode.Uri.file(join(process.cwd(), 'dist')),
    vscode.Uri.file(join(process.cwd(), '.artifacts/provider-initialization')),
  );

  provider.resolveWebviewView(view);
  const ready = () => {
    for (const listener of messages)
      listener({
        requestId: 'initialization',
        repositoryId: '',
        generation: 0,
        body: { kind: 'ready', savedRepositoryId: null },
      });
  };

  return { provider, delivered, ready };
}

afterEach(() => {
  host.initialize();
});

test('disposing the provider during discovery removes its pending listener without an error', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.provider.dispose());
  f.ready();
  await vi.waitFor(() => expect(host.listeners.size).toBe(1));
  f.provider.dispose();
  await vi.waitFor(() => expect(host.listeners.size).toBe(0));
  expect(f.delivered).toEqual([]);
  expect(host.errors).toEqual([]);
});

test('replacing pending initialization releases the previous discovery listener', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.provider.dispose());
  f.ready();
  await vi.waitFor(() => expect(host.listeners.size).toBe(1));
  for (const listener of host.configuration)
    listener({ affectsConfiguration: (section) => section === 'git.enabled' });
  await vi.waitFor(() => expect(host.activationCount).toBe(2));
  expect(host.listeners.size).toBe(1);
  expect(host.errors).toEqual([]);
});

test('closing during native extension activation prevents a later discovery subscription', async (t) => {
  const f = fixture();
  const release = host.holdActivation();

  t.onTestFinished(() => {
    release();
    f.provider.dispose();
  });
  f.ready();
  await vi.waitFor(() => expect(host.activationCount).toBe(1));
  f.provider.dispose();
  release();
  await Promise.resolve();
  await Promise.resolve();
  expect(host.listeners.size).toBe(0);
  expect(host.errors).toEqual([]);
  expect(f.delivered).toEqual([]);
});
