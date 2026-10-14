import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, type Frame } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { LOG_VIEW_ID } from '../../src/shared/extension-identity';
import { nativeBrowser, refreshNativeHistory } from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';

describe('native branch multiselection', () => {
  it('registered batch Delete uses the selected group and native Restore without a confirmation', async () => {
    const f = await createFixture({
      prefix: 'git-ui-native native branch range ',
    });
    const root = vscode.Uri.file(f.root);
    const id = root.toString();
    const head = (await f.runGit(['rev-parse', 'HEAD'])).trim();
    const menu = vscode.workspace.getConfiguration('window');
    const previous = menu.inspect<string>('menuStyle')?.globalValue;

    try {
      await menu.update(
        'menuStyle',
        'custom',
        vscode.ConfigurationTarget.Global,
      );
      for (const name of ['alpha', 'beta', 'gamma'])
        await f.runGit(['branch', name, head]);
      await writeFile(join(f.root, 'local.txt'), 'Preserve local work');
      const access = await getGitApi();

      await access.api.openRepository(root);
      await access.repository(id).status();
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      const browser = await nativeBrowser();
      let frame: Frame | undefined;

      await expect
        .poll(async () => {
          for (const context of browser.contexts())
            for (const page of context.pages())
              for (const candidate of page.frames())
                if (await candidate.locator('#branches').count())
                  frame = candidate;

          return !!frame;
        })
        .toBe(true);
      assert.ok(frame);
      await frame.page().bringToFront();
      await refreshNativeHistory(frame, id);
      const alpha = frame.locator('[data-ref="refs/heads/alpha"]');
      const gamma = frame.locator('[data-ref="refs/heads/gamma"]');

      await alpha.click();
      await gamma.click({ modifiers: ['Shift'] });
      await expect(
        frame.locator('[data-ref][aria-selected="true"]'),
      ).toHaveCount(3);
      const workbench = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().includes('/workbench/workbench.html'));

      assert.ok(workbench);

      await vscode.commands.executeCommand('notifications.clearAll');
      await gamma.click({ button: 'right' });
      const deletion = workbench.getByRole('menuitem', {
        name: 'Delete',
        exact: true,
      });

      await expect(deletion).toBeVisible();
      await expect(deletion).toBeEnabled();
      await expect(
        workbench.getByRole('menuitem', { name: 'Checkout', exact: true }),
      ).toHaveCount(0);
      // VS Code delays custom-menu mouseup handlers by 100ms to ignore the opener.
      await workbench.waitForTimeout(120);
      await deletion.click();
      await expect
        .poll(async () =>
          (
            await f.runGit([
              'for-each-ref',
              '--format=%(refname)',
              'refs/heads/alpha',
              'refs/heads/beta',
              'refs/heads/gamma',
            ])
          ).trim(),
        )
        .toBe('')
        .catch(async (error: unknown) => {
          await writeFile(
            '.artifacts/native-branch-multiselection-failure.json',
            JSON.stringify({
              context: await gamma.getAttribute('data-vscode-context'),
              status: await frame!.locator('#status').textContent(),
              workbench: await workbench.locator('body').innerText(),
            }),
          );
          throw error;
        });
      await vscode.commands.executeCommand('notifications.showList');
      const notification = workbench
        .locator('.notification-list-item')
        .filter({ hasText: 'Deleted 3 branches.' });

      await expect(notification).toHaveCount(1);
      await notification
        .getByRole('button', { name: 'Restore', exact: true })
        .click();
      await expect
        .poll(async () =>
          (
            await f.runGit([
              'for-each-ref',
              '--format=%(refname)',
              'refs/heads/alpha',
              'refs/heads/beta',
              'refs/heads/gamma',
            ])
          )
            .trim()
            .split('\n'),
        )
        .toEqual(['refs/heads/alpha', 'refs/heads/beta', 'refs/heads/gamma']);
      for (const name of ['alpha', 'beta', 'gamma'])
        assert.equal((await f.runGit(['rev-parse', name])).trim(), head);
      assert.equal(
        (await f.runGit(['branch', '--show-current'])).trim(),
        'main',
      );
      assert.match(await f.runGit(['status', '--porcelain']), /local.txt/);
    } finally {
      await vscode.commands.executeCommand('notifications.clearAll');
      await menu.update(
        'menuStyle',
        previous,
        vscode.ConfigurationTarget.Global,
      );
      await f.dispose();
    }
  });
});
