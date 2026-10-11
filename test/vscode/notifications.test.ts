import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { messagePrompt } from '../../src/extension/changes/prompts';
import { askWorktree } from '../../src/extension/native/branch-integration';
import { showOperationError } from '../../src/extension/native/operation-feedback';
import { nativeBrowser } from '../fixtures/native-panel';

describe('operation result notification lifecycle', () => {
  it('reporting an error completes while its actionable notification remains visible', async () => {
    const browser = await nativeBrowser();
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) =>
        candidate.url().includes('/workbench/workbench.html'),
      );

    assert.ok(page);
    // This isolated test window can retain other fixtures' notifications.
    // Start with an empty center so its virtual list displays this result.
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('notifications.hideList');
    await page.bringToFront();
    let completed = false;
    const report = showOperationError('Fixture completed operation error').then(
      () => {
        completed = true;
      },
    );

    try {
      await expect.poll(() => completed).toBe(true);
      await vscode.commands.executeCommand('notifications.showList');
      // Toasts and an already-open notification center expose different roles.
      await expect(
        page.getByText('Fixture completed operation error', { exact: true }),
      )
        .toBeVisible()
        .catch(async (error: unknown) => {
          await writeFile(
            '.artifacts/error-notification-diagnostic.json',
            JSON.stringify(
              await Promise.all(
                browser
                  .contexts()
                  .flatMap((context) => context.pages())
                  .map(async (candidate) => ({
                    url: candidate.url(),
                    text: await candidate.locator('body').innerText(),
                  })),
              ),
              null,
              2,
            ),
          );
          throw error;
        });
    } finally {
      await vscode.commands.executeCommand('notifications.showList');
      const dismiss = page
        .locator('.notification-list-item')
        .filter({ hasText: 'Fixture completed operation error' })
        .getByRole('button', { name: 'Dismiss', exact: true });

      if (await dismiss.count())
        await dismiss.evaluate((node) => (node as HTMLElement).click());
      await report;
      await vscode.commands.executeCommand('notifications.hideList');
    }
  });
});

describe('input validation notifications', () => {
  async function workbench() {
    const browser = await nativeBrowser();
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) =>
        candidate.url().includes('/workbench/workbench.html'),
      );

    assert.ok(page);
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('notifications.hideList');

    return page;
  }

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await vscode.commands.executeCommand('notifications.clearAll');
  });

  it('a blank message notifies and keeps the prompt available for correction', async () => {
    const page = await workbench();
    const drafts: string[] = [];
    const result = messagePrompt({
      title: 'Fixture Message',
      prompt: 'Enter a message',
      draft: '',
      onDraft: (draft) => drafts.push(draft),
    });
    const widget = page.locator('.quick-input-widget:visible');
    const input = widget.locator('input').first();

    await expect(widget).toContainText('Fixture Message');
    await input.fill(' ');
    await input.press('Enter');
    await vscode.commands.executeCommand('notifications.showList');
    await expect(
      page.locator('.notification-list-item').filter({
        hasText: 'Enter a message to continue.',
      }),
    ).toBeVisible();
    await expect(widget).toBeVisible();
    await vscode.commands.executeCommand('notifications.hideList');
    await input.fill('Save selected changes');
    await input.press('Enter');
    assert.equal(await result, 'Save selected changes');
    assert.equal(drafts.at(-1), 'Save selected changes');
  });

  it('a relative worktree folder notifies and can be corrected before accepting', async () => {
    const page = await workbench();
    const root = join(tmpdir(), 'git-ui-input-repository');
    const folder = join(tmpdir(), 'git-ui-input-worktree');
    const result = askWorktree(
      {
        id: 'refs/heads/topic',
        name: 'topic',
        kind: 'local',
        sha: 'a'.repeat(40),
        remote: null,
      },
      vscode.Uri.file(root).toString(),
      'main',
    );
    const widget = page.locator('.quick-input-widget:visible');
    const input = widget.locator('input').first();

    await expect(widget).toContainText('New Worktree from "topic"');
    await input.press('Enter');
    await expect(widget).toContainText('Worktree Folder');
    await input.fill('relative-folder');
    await input.press('Enter');
    await vscode.commands.executeCommand('notifications.showList');
    await expect(
      page.locator('.notification-list-item').filter({
        hasText: 'Enter an absolute folder path.',
      }),
    ).toBeVisible();
    await expect(input).toHaveValue('relative-folder');
    await vscode.commands.executeCommand('notifications.hideList');
    await input.fill(folder);
    await input.press('Enter');
    assert.deepEqual(await result, { path: folder, name: null });
  });
});
