import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import type { Frame } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import {
  commandId,
  extensionIdentity,
  LOG_VIEW_ID,
} from '../../../src/shared/extension-identity';
import { divergentFixture } from '../../fixtures/branch-update';
import { nativeBrowser } from '../../fixtures/native-panel';

// The installed-copy driver exercises the packaged extension's registered
// commands and native notifications in a normal, isolated workbench.
export async function run() {
  const extension = vscode.extensions.all.find(
    (entry) => entry.packageJSON.name === extensionIdentity.name,
  );

  assert.ok(extension);
  assert.ok(process.env.GIT_UI_INSTALLED_ROOT);
  const location = relative(
    process.env.GIT_UI_INSTALLED_ROOT,
    extension.extensionPath,
  );

  assert.ok(location && !isAbsolute(location) && !location.startsWith('..'));
  await extension.activate();
  const passed: string[] = [];
  const browser = await nativeBrowser();
  const workbench = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().includes('/workbench/workbench.html'));

  assert.ok(workbench);
  await workbench.bringToFront();

  for (const choice of [
    'Rebase',
    'Merge',
    'Current Cancel',
    'Fast-forward',
    'Up-to-date',
    'Blocked',
    'Cancel',
    'Checkout',
  ] as const) {
    const current =
      choice === 'Rebase' ||
      choice === 'Merge' ||
      choice === 'Up-to-date' ||
      choice === 'Current Cancel';
    const cancelled = choice === 'Cancel' || choice === 'Current Cancel';
    const target = current ? 'main' : 'topic';
    const selector = `[data-ref="refs/heads/${target}"]`;
    const f = await divergentFixture(target);
    let operation: Promise<unknown> | undefined;
    let frame: Frame | undefined;
    let completed = false;

    try {
      const localSettings = join(f.root, '.idea', 'workspace.xml');

      if (choice === 'Fast-forward')
        await f.runGit(['update-ref', 'refs/heads/topic', f.base, f.local]);
      if (choice === 'Up-to-date') {
        await f.runGit([
          '--git-dir',
          f.remote,
          'fetch',
          f.root,
          `${f.local}:refs/heads/noop-local`,
        ]);
        await f.runGit([
          '--git-dir',
          f.remote,
          'update-ref',
          'refs/heads/main',
          f.local,
        ]);
      }

      if (
        choice === 'Blocked' ||
        choice === 'Fast-forward' ||
        choice === 'Up-to-date'
      ) {
        await mkdir(join(f.root, '.idea'));
        await writeFile(localSettings, 'local IDE settings');
      }

      await f.access.repository(f.id).status();

      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      await expect
        .poll(async () => {
          for (const context of browser.contexts())
            for (const page of context.pages())
              for (const candidate of page.frames())
                if (await candidate.locator(selector).count()) {
                  const context = JSON.parse(
                    (await candidate
                      .locator(selector)
                      .getAttribute('data-vscode-context')) ?? '{}',
                  );

                  if (context.repositoryId === f.id) frame = candidate;
                }

          return Boolean(frame);
        })
        .toBe(true);
      assert.ok(frame);
      const branch = frame.locator(selector);

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

      assert.equal(context.refCurrent, current);
      assert.equal(context.refCanUpdate, true);
      operation = Promise.resolve(
        vscode.commands.executeCommand(commandId('update-branch'), context),
      );
      void operation.then(
        () => {
          completed = true;
        },
        () => {},
      );

      if (choice === 'Fast-forward' || choice === 'Up-to-date') {
        const success = workbench.getByRole('dialog', {
          name:
            choice === 'Fast-forward'
              ? 'Info: Updated "topic": 1 incoming commit.'
              : 'Info: "main" is already up to date.',
        });

        // This first notification follows a real fetch and branch update.
        await expect(
          workbench.getByText(
            choice === 'Fast-forward'
              ? 'Updated "topic": 1 incoming commit.'
              : '"main" is already up to date.',
            { exact: true },
          ),
        ).toBeVisible({ timeout: 30000 });
        await expect(success.locator('.notification-list-item')).toHaveClass(
          /\bexpanded\b/,
        );
        await expect(
          success.getByRole('button', { name: 'Dismiss', exact: true }),
        ).toBeVisible();
        await expect
          .poll(() => completed, {
            message:
              'Success must complete without dismissing its notification',
          })
          .toBe(true);
        await operation;
        if (choice === 'Up-to-date') {
          await workbench.bringToFront();
          await workbench.mouse.move(0, 0);
          await branch.focus();
          await expect(success).toHaveCount(0, { timeout: 25000 });
          await vscode.commands.executeCommand('notifications.showList');
          await expect(success).toBeVisible();
          await vscode.commands.executeCommand('notifications.hideList');
        } else
          await success
            .getByRole('button', { name: 'Dismiss', exact: true })
            .evaluate((node) => (node as HTMLElement).click());
        await expect(success).toHaveCount(0);
        assert.equal(
          (await f.runGit(['rev-parse', target])).trim(),
          choice === 'Fast-forward' ? f.incoming : f.local,
        );
        assert.equal(
          (await f.runGit(['rev-parse', 'HEAD'])).trim(),
          choice === 'Fast-forward' ? f.base : f.local,
        );
        assert.equal(
          (await f.runGit(['symbolic-ref', '--short', 'HEAD'])).trim(),
          'main',
        );
        assert.equal(
          await readFile(localSettings, 'utf8'),
          'local IDE settings',
        );
        assert.equal((await f.runGit(['stash', 'list'])).trim(), '');
        assert.equal(
          (await f.runGit(['--git-dir', f.remote, 'rev-parse', 'main'])).trim(),
          choice === 'Fast-forward' ? f.incoming : f.local,
        );
        if (choice === 'Fast-forward') {
          const invalid = vscode.commands.executeCommand(
            commandId('update-branch'),
            {},
          );
          const error = workbench.getByRole('dialog', {
            name: 'Error: Select a branch in Git UI before using this action.',
          });

          await expect(error).toBeVisible();
          await expect(error.locator('.notification-list-item')).toHaveClass(
            /\bexpanded\b/,
          );
          await error
            .getByRole('button', { name: 'Dismiss', exact: true })
            .evaluate((node) => (node as HTMLElement).click());
          await invalid;
          await expect(error).toHaveCount(0);
          assert.equal((await f.runGit(['rev-parse', 'HEAD'])).trim(), f.base);
          assert.equal(
            (await f.runGit(['rev-parse', 'topic'])).trim(),
            f.incoming,
          );
        }

        passed.push(
          choice === 'Fast-forward'
            ? 'registered other-branch fast-forward retains checkout and local IDE settings'
            : 'registered current no-op fetch retains local IDE settings',
        );

        continue;
      }

      const updateNotification = workbench.getByRole('dialog', {
        name: current
          ? 'Error: "main" has local commits and incoming changes. Choose Rebase or Merge.'
          : 'Error: "topic" has local commits and incoming changes. Check it out to update it.',
      });

      await expect(updateNotification).toBeVisible({ timeout: 30000 });
      await expect(workbench.locator('.monaco-dialog-box:visible')).toHaveCount(
        0,
      );
      await expect(
        updateNotification.locator('.notification-list-item'),
      ).toHaveClass(/\bexpanded\b/);
      if (!current) {
        await expect(
          updateNotification.getByRole('button', {
            name: 'Checkout Branch',
            exact: true,
          }),
        ).toBeVisible();
      }

      if (choice === 'Blocked') {
        await expect(
          workbench.getByRole('button', {
            name: 'Checkout Branch',
            exact: true,
          }),
        ).toBeVisible();
        await workbench
          .getByRole('button', { name: 'Checkout Branch', exact: true })
          .evaluate((node) => (node as HTMLElement).click());
        const notification = workbench.getByRole('dialog', {
          name: /Error: Commit or stash local changes/,
        });

        await expect(notification).toBeVisible();
        await expect(
          notification.locator('.notification-list-item'),
        ).toHaveClass(/\bexpanded\b/);
        await expect(notification).toContainText(
          'Commit or stash local changes before checking out "topic".',
        );
        await expect(
          workbench.getByRole('button', { name: 'Rebase', exact: true }),
        ).toHaveCount(0);
        const sourceControl = notification.getByRole('button', {
          name: 'Open Source Control',
          exact: true,
        });

        await expect(sourceControl).toBeVisible();
        await sourceControl.evaluate((node) => (node as HTMLElement).click());
        await operation;
        await expect(
          workbench.locator('[id="workbench.view.scm"]'),
        ).toBeVisible();
        assert.equal(
          (await f.runGit(['symbolic-ref', '--short', 'HEAD'])).trim(),
          'main',
        );
        assert.equal((await f.runGit(['rev-parse', 'HEAD'])).trim(), f.base);
        assert.equal((await f.runGit(['rev-parse', 'topic'])).trim(), f.local);
        assert.equal(
          (await f.runGit(['rev-parse', 'origin/main'])).trim(),
          f.incoming,
        );
        assert.equal(
          await readFile(localSettings, 'utf8'),
          'local IDE settings',
        );
        assert.equal((await f.runGit(['stash', 'list'])).trim(), '');
        passed.push(
          'explicit checkout with local edits shows an actionable native error',
        );

        continue;
      }

      if (current)
        await expect(
          workbench.getByText(
            '"main" has local commits and incoming changes. Choose Rebase or Merge.',
            { exact: true },
          ),
        )
          .toBeVisible()
          .catch(async (error: unknown) => {
            await writeFile(
              `.artifacts/update-menu-diagnostic-${choice}.json`,
              JSON.stringify(
                {
                  context,
                  currentContext: await branch.getAttribute(
                    'data-vscode-context',
                  ),
                  status: await frame!.locator('#status').textContent(),
                  workbench: await workbench.locator('body').innerText(),
                },
                null,
                2,
              ),
            );
            throw error;
          });
      for (const action of current
        ? ['Rebase', 'Merge', 'Cancel']
        : ['Checkout Branch'])
        await expect(
          workbench.getByRole('button', { name: action, exact: true }),
        ).toBeVisible();
      if (!current) {
        for (const action of ['Rebase', 'Merge'])
          await expect(
            workbench.getByRole('button', { name: action, exact: true }),
          ).toHaveCount(0);
      }

      if (choice === 'Cancel')
        await updateNotification
          .getByRole('button', { name: /Clear Notification/ })
          .evaluate((node) => (node as HTMLElement).click());
      else
        await workbench
          .getByRole('button', {
            name:
              choice === 'Checkout'
                ? 'Checkout Branch'
                : choice === 'Current Cancel'
                  ? 'Cancel'
                  : choice,
            exact: true,
          })
          .evaluate((node) => (node as HTMLElement).click());
      await operation;
      if (!cancelled)
        await expect(
          workbench.getByText(
            current
              ? `Updated "main" with ${choice}: 1 incoming commit.`
              : 'Checked out "topic". Choose Update Branch to update it.',
            { exact: true },
          ),
        ).toBeVisible();
      assert.equal(
        (await f.runGit(['symbolic-ref', '--short', 'HEAD'])).trim(),
        choice === 'Checkout' ? 'topic' : 'main',
      );
      const tip = (await f.runGit(['rev-parse', target])).trim();

      if (cancelled || choice === 'Checkout') assert.equal(tip, f.local);
      else {
        const parents = (await f.runGit(['show', '-s', '--format=%P', tip]))
          .trim()
          .split(' ');

        assert.deepEqual(
          parents,
          choice === 'Merge' ? [f.local, f.incoming] : [f.incoming],
        );
      }

      assert.equal(
        (await f.runGit(['rev-parse', 'HEAD'])).trim(),
        current || choice === 'Checkout' ? tip : f.base,
      );
      if (!current)
        assert.equal((await f.runGit(['rev-parse', 'main'])).trim(), f.base);

      assert.equal(
        (await f.runGit(['--git-dir', f.remote, 'rev-parse', 'main'])).trim(),
        f.incoming,
      );
      assert.equal((await f.runGit(['stash', 'list'])).trim(), '');
      passed.push(
        `registered Update on ${current ? 'current' : 'another'} branch completes ${choice === 'Cancel' ? 'notification dismissal' : choice}`,
      );
    } catch (error) {
      const state =
        frame && !frame.isDetached()
          ? {
              context: await frame
                .locator(selector)
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
      const notifications = await workbench
        .locator('.notifications-toasts, .notifications-center')
        .allTextContents()
        .then((items) => items.join('\n').slice(0, 2000))
        .catch(() => null);

      throw new Error(
        `${choice}: ${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({ completed, state, notifications })}`,
        { cause: error },
      );
    } finally {
      try {
        const cancel = workbench.getByRole('button', {
          name: 'Cancel',
          exact: true,
        });

        if (await cancel.count())
          await cancel.evaluate((node) => (node as HTMLElement).click());
      } finally {
        try {
          await vscode.commands.executeCommand('notifications.clearAll');
          if (operation) await operation.catch(() => {});
        } finally {
          await f.dispose();
        }
      }
    }
  }

  return passed;
}
