import assert from 'node:assert/strict';
import { lstat, rm } from 'node:fs/promises';

import type { Frame } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { LOG_VIEW_ID } from '../../../src/shared/extension-identity';
import { divergentFixture } from '../../fixtures/branch-update';
import { nativeBrowser } from '../../fixtures/native-panel';

export async function run(): Promise<string[]> {
  const passed: string[] = [];
  const browser = await nativeBrowser();
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes('/workbench/workbench.html'));

  assert.ok(page);

  for (const scenario of [
    'Merge',
    'Rebase',
    'Merge Cancel',
    'Rebase Cancel',
    'Existing Worktree',
    'Remote Worktree',
    'Worktree Cancel',
  ] as const) {
    const f = await divergentFixture('main');
    const path = f.root + '-accepted-worktree';
    const remote = scenario === 'Remote Worktree';
    const refId = remote ? 'refs/remotes/origin/feature' : 'refs/heads/feature';
    const worktree = scenario.includes('Worktree');
    const cancel = scenario.includes('Cancel');
    const method = scenario.startsWith('Rebase') ? 'Rebase' : 'Merge';
    let frame: Frame | undefined;
    let operation: Thenable<unknown> | undefined;

    try {
      await f.runGit(['update-ref', refId, f.incoming]);
      await f.access.repository(f.id).status();
      await vscode.commands.executeCommand('notifications.clearAll');
      await vscode.commands.executeCommand('notifications.hideList');
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      await expect
        .poll(async () => {
          for (const context of browser.contexts())
            for (const candidate of context.pages())
              for (const item of candidate.frames()) {
                const branch = item.locator(`[data-ref="${refId}"]`);

                if (!(await branch.count())) continue;
                const context = JSON.parse(
                  (await branch.getAttribute('data-vscode-context')) ?? '{}',
                );

                if (context.repositoryId === f.id) frame = item;
              }

          return !!frame;
        })
        .toBe(true);
      assert.ok(frame);
      const branch = frame.locator(`[data-ref="${refId}"]`);

      await expect(frame.locator('#history')).not.toHaveAttribute('inert', '');
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
      const context = JSON.parse(
        (await branch.getAttribute('data-vscode-context')) ?? '{}',
      );

      assert.equal(context.refCanIntegrate, true);
      operation = vscode.commands.executeCommand(
        `gitUI.${worktree ? 'create-worktree' : method === 'Merge' ? 'merge-branch' : 'rebase-branch'}`,
        context,
      );
      // Rethrow command failures when awaited, without an unhandled rejection while driving its UI.
      void Promise.resolve(operation).catch(() => {});
      if (!worktree) {
        const message =
          method === 'Merge'
            ? 'Merge "feature" into "main"?'
            : 'Rebase "main" on "feature"? This rewrites its local commits.';
        const notice = page.getByRole('dialog', { name: `Info: ${message}` });

        await page.bringToFront();
        await vscode.commands.executeCommand('notifications.showList');
        await expect(notice).toBeVisible();
        await expect(page.locator('.monaco-dialog-box:visible')).toHaveCount(0);
        await notice
          .getByRole('button', {
            name: cancel ? 'Cancel' : method,
            exact: true,
          })
          .evaluate((node) => (node as HTMLElement).click());
      } else {
        const widget = page.locator('.quick-input-widget:visible');
        const input = widget.locator('input').first();

        if (remote) {
          await expect(widget).toContainText('Create Branch');
          await input.fill('accepted-worktree');
          await input.press('Enter');
        } else {
          await expect(widget).toContainText('New Worktree from "feature"');
          await input.press('Enter');
        }

        await expect(widget).toContainText('Worktree Folder');
        if (cancel) await input.press('Escape');
        else {
          await input.fill(path);
          await input.press('Enter');
        }
      }

      await operation;
      assert.equal(
        (await f.runGit(['branch', '--show-current'])).trim(),
        'main',
      );
      assert.equal((await f.runGit(['rev-parse', refId])).trim(), f.incoming);
      if (cancel) {
        assert.equal((await f.runGit(['rev-parse', 'HEAD'])).trim(), f.local);
        await assert.rejects(lstat(path), { code: 'ENOENT' });
      } else if (worktree) {
        assert.equal(
          (await f.runGit(['-C', path, 'rev-parse', 'HEAD'])).trim(),
          f.incoming,
        );
        assert.equal(
          (await f.runGit(['-C', path, 'branch', '--show-current'])).trim(),
          remote ? 'accepted-worktree' : 'feature',
        );
        assert.equal((await f.runGit(['rev-parse', 'HEAD'])).trim(), f.local);
        if (remote)
          assert.equal(
            (
              await f.runGit([
                'rev-parse',
                '--symbolic-full-name',
                'accepted-worktree@{upstream}',
              ])
            ).trim(),
            refId,
          );
      } else {
        const parents = (await f.runGit(['show', '-s', '--format=%P', 'HEAD']))
          .trim()
          .split(' ');

        assert.deepEqual(
          parents,
          method === 'Merge' ? [f.local, f.incoming] : [f.incoming],
        );
      }

      assert.equal((await f.runGit(['stash', 'list'])).trim(), '');
      passed.push(
        `registered ${scenario} reviews branch names and preserves source/checkout contracts`,
      );
    } catch (error) {
      const state =
        frame && !frame.isDetached()
          ? {
              context: await frame
                .locator(`[data-ref="${refId}"]`)
                .getAttribute('data-vscode-context', { timeout: 1000 })
                .catch(() => null),
              status: await frame
                .locator('#status')
                .textContent({ timeout: 1000 })
                .catch(() => null),
              busy: await frame
                .locator('#history')
                .getAttribute('inert', { timeout: 1000 })
                .catch(() => null),
            }
          : null;
      const workbench = await page
        .locator('body')
        .innerText({ timeout: 1000 })
        .then((text) => text.slice(0, 2000))
        .catch(() => null);

      throw new Error(
        `${scenario}: ${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({ state, workbench })}`,
        { cause: error },
      );
    } finally {
      try {
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await vscode.commands.executeCommand('notifications.clearAll');
        if (operation) await Promise.resolve(operation).catch(() => {});
      } finally {
        try {
          if (
            await lstat(path).then(
              () => true,
              () => false,
            )
          )
            await f.runGit(['worktree', 'remove', path]);
        } finally {
          await Promise.all([
            rm(path, { recursive: true, force: true }),
            f.dispose(),
          ]);
        }
      }
    }
  }

  return passed;
}
