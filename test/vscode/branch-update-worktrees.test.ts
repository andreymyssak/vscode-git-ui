import assert from 'node:assert/strict';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { commandId, LOG_VIEW_ID } from '../../src/shared/extension-identity';
import { divergentFixture } from '../fixtures/branch-update';
import {
  refreshNativeHistory,
  selectNativeRepository,
} from '../fixtures/native-panel';

async function overwriteMarker({
  path,
  contents,
}: {
  path: string;
  contents: string;
}) {
  // Git can mark .git hidden on Windows, where opening it with 'w' fails.
  const file = await open(join(path, '.git'), 'r+');

  try {
    await file.truncate(0);
    await file.writeFile(contents);
  } finally {
    await file.close();
  }
}

describe('Update with an uncheckable worktree', () => {
  it('shows the broken worktree in a native notification and preserves checkout, edits, staging and refs', async () => {
    const f = await divergentFixture('topic');
    const path = f.root + '-broken worktree';
    let originalGit: string | undefined;

    try {
      await f.runGit(['worktree', 'add', '--detach', path, f.base]);
      originalGit = await readFile(join(path, '.git'), 'utf8');
      await overwriteMarker({
        path,
        contents: `gitdir: ${path}-missing-metadata\n`,
      });
      await writeFile(join(f.root, 'sample.txt'), 'staged local work\n');
      await f.runGit(['add', 'sample.txt']);
      await writeFile(join(f.root, 'sample.txt'), 'unstaged local work\n');
      const staged = await f.runGit(['diff', '--cached', '--binary']);
      const working = await f.runGit(['diff', '--binary']);
      const refs = await f.runGit(['show-ref']);

      await f.access.repository(f.id).status();
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      const frame = await selectNativeRepository(f.id);

      await refreshNativeHistory(frame, f.id);
      const branch = frame.locator('[data-ref="refs/heads/topic"]');

      await expect(branch).toBeVisible();
      await branch.evaluate((node) => {
        node.addEventListener(
          'contextmenu',
          (event) => event.preventDefault(),
          { once: true },
        );
        node.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
      });
      const context: unknown = JSON.parse(
        (await branch.getAttribute('data-vscode-context')) ?? 'null',
      );

      await vscode.commands.executeCommand('notifications.clearAll');
      await vscode.commands.executeCommand(commandId('update-branch'), context);
      await vscode.commands.executeCommand('notifications.showList');
      const notification = frame
        .page()
        .locator('.notification-list-item')
        .filter({ hasText: 'Cannot check worktree' });

      await expect(notification).toHaveCount(1);
      // Git reports worktree paths with forward slashes on Windows.
      await expect(notification).toContainText(path.replaceAll('\\', '/'));
      await expect(notification).toContainText('Git metadata');
      await expect(notification).toContainText('Update stopped');
      await expect(notification).toContainText(/repair.*refresh/i);
      await expect(notification).not.toContainText('Command failed');
      assert.equal(await f.runGit(['show-ref']), refs);
      assert.equal(await f.runGit(['diff', '--cached', '--binary']), staged);
      assert.equal(await f.runGit(['diff', '--binary']), working);
      assert.equal(
        (await f.runGit(['branch', '--show-current'])).trim(),
        'main',
      );
      assert.equal((await f.runGit(['rev-parse', 'HEAD'])).trim(), f.base);
      assert.equal((await f.runGit(['stash', 'list'])).trim(), '');
      assert.equal(
        await readFile(join(path, '.git'), 'utf8'),
        `gitdir: ${path}-missing-metadata\n`,
      );
    } finally {
      try {
        await vscode.commands.executeCommand('notifications.clearAll');
        await vscode.commands.executeCommand('notifications.hideList');
        if (originalGit !== undefined)
          await overwriteMarker({ path, contents: originalGit });
      } finally {
        try {
          await f.dispose();
        } finally {
          await rm(path, { recursive: true, force: true });
        }
      }
    }
  });
});
