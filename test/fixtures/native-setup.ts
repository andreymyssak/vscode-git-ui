import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { nativeBrowser } from './native-panel';

export async function mochaGlobalSetup(): Promise<void> {
  // Attach before tests create webviews so CDP observes their nested frames.
  await nativeBrowser();
  const retired = new Set<string>();

  // Closing Git repositories does not cancel queued native decoration requests.
  // Keep their disposable files until this test host can no longer run those requests.
  process.once('exit', () => {
    for (const root of retired)
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  globalThis.gitUiFixtureCleanup = async (root) => {
    const access = await getGitApi();
    const owns = (path: string) => {
      const child = relative(root, path);

      return (
        (!isAbsolute(child) &&
          child !== '..' &&
          !child.startsWith(`..${sep}`)) ||
        path.startsWith(`${root}.`)
      );
    };

    const owned = access.api.repositories.filter((repo) =>
      owns(repo.rootUri.fsPath),
    );

    for (const repository of owned) {
      await vscode.commands.executeCommand('git.close', repository.rootUri);
      retired.add(repository.rootUri.fsPath);
    }

    assert.ok(
      !access.api.repositories.some((repo) => owns(repo.rootUri.fsPath)),
      'Close native Git repositories before deleting their fixture files.',
    );
    retired.add(root);

    return true;
  };
}
