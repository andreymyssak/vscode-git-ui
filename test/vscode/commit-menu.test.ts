import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import type { Frame, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import {
  commandId,
  EXTENSION_ID,
  extensionIdentity,
  LOG_VIEW_ID,
} from '../../src/shared/extension-identity';
import {
  nativeBrowser,
  nativePanel,
  refreshNativeHistory,
  trackNativeDrafts,
} from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';

describe('native squash menu workflow', () => {
  it('shows single-commit actions and an enabled Squash menu for a selected range', async () => {
    const fixture = await createFixture({
      prefix: 'git-ui-native commit menu ',
    });
    const sampleUri = vscode.Uri.file(join(fixture.root, 'sample.txt'));
    const menu = vscode.workspace.getConfiguration('window');
    const previous = menu.inspect<string>('menuStyle')?.globalValue;
    let workbench: Page | undefined;

    try {
      await menu.update(
        'menuStyle',
        'custom',
        vscode.ConfigurationTarget.Global,
      );
      const extension = vscode.extensions.getExtension(EXTENSION_ID);

      assert.ok(extension);
      await extension.activate();
      if (process.env.GIT_UI_INSTALLED_ROOT) {
        const location = relative(
          process.env.GIT_UI_INSTALLED_ROOT,
          extension.extensionPath,
        );

        assert.ok(
          location && !isAbsolute(location) && !location.startsWith('..'),
          'exercise installed VSIX commands',
        );
      }

      for (const message of ['Older menu commit', 'Newest menu commit'])
        await fixture.runGit(['commit', '--allow-empty', '-m', message]);
      const id = vscode.Uri.file(fixture.root).toString();
      const access = await getGitApi();

      await access.api.openRepository(vscode.Uri.file(fixture.root));
      await access.repository(id).status();
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      const frame = await nativePanel(id);

      workbench = frame.page();
      const contextMenu = workbench.locator('.monaco-menu');

      await workbench.bringToFront();
      const rows = frame.locator('[data-commit-row]');

      const references = rows.first().locator('[data-references]');

      await references.hover();
      await expect(frame.locator('[data-reference-tooltip]')).toBeVisible();
      await references.focus();
      await vscode.window.showTextDocument(sampleUri);
      await expect
        .poll(() => frame.evaluate(() => document.hasFocus()))
        .toBe(false);
      await refreshNativeHistory(frame, id);
      await expect(frame.locator('[data-reference-tooltip]')).toHaveCount(0);
      const singleActions = [
        /^Copy Revision Number$/,
        /^Edit Commit Message/,
        /^New Branch/,
        /^New Tag/,
      ];

      await rows.first().click();
      await rows.first().click({ button: 'right' });
      for (const name of singleActions)
        await expect(contextMenu.getByRole('menuitem', { name })).toBeVisible();
      await expect(
        contextMenu.getByRole('menuitem', { name: /^Squash Commits/ }),
      ).toHaveCount(0);
      await workbench.keyboard.press('Escape');
      await expect(contextMenu.getByRole('menuitem')).toHaveCount(0);
      await rows.nth(1).click({ modifiers: ['Shift'] });
      await expect(
        frame.locator('[data-commit-row][aria-selected="true"]'),
      ).toHaveCount(2);
      await expect
        .poll(async () => {
          const context = JSON.parse(
            (await rows.first().getAttribute('data-vscode-context')) ?? '{}',
          ) as { commitCanSquash?: boolean };

          return context.commitCanSquash;
        })
        .toBe(true);
      await rows.first().click({ button: 'right' });
      const squash = contextMenu.getByRole('menuitem', {
        name: /^Squash Commits/,
      });

      await expect(squash).toBeVisible();
      await expect(squash).toBeEnabled();
      for (const name of singleActions)
        await expect(contextMenu.getByRole('menuitem', { name })).toHaveCount(
          0,
        );
    } finally {
      try {
        if (workbench) await workbench.keyboard.press('Escape');
      } finally {
        try {
          const tabs = vscode.window.tabGroups.all.flatMap((group) =>
            group.tabs.filter(
              (tab) =>
                tab.input instanceof vscode.TabInputText &&
                tab.input.uri.toString() === sampleUri.toString(),
            ),
          );

          if (tabs.length) await vscode.window.tabGroups.close(tabs);
        } finally {
          await Promise.all([
            menu.update(
              'menuStyle',
              previous,
              vscode.ConfigurationTarget.Global,
            ),
            fixture.dispose(),
          ]);
        }
      }
    }
  });

  // Six native actions and real Git verification need extra time on Windows.
  it('registered commands route named refs, Squash and Drop through the bundled native operation', async () => {
    const browser = await nativeBrowser();
    const workbench = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) =>
        candidate.url().includes('/workbench/workbench.html'),
      );

    assert.ok(workbench);
    const fixture = await createFixture({
      prefix: 'git-ui-native native menu ü ',
    });
    const drafts = trackNativeDrafts();
    let pending: Thenable<unknown> | undefined;

    let frame: Frame | undefined;

    try {
      const base = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const shas: string[] = [];

      for (const [index, name] of ['Oldest', 'Middle', 'Newest'].entries()) {
        await writeFile(join(fixture.root, 'sample.txt'), `menu ${index}\n`);
        await fixture.runGit(['add', 'sample.txt']);
        await fixture.runGit([
          'commit',
          '-m',
          `Menu ${name}`,
          '-m',
          `Full ${name} body ü`,
        ]);
        shas.unshift((await fixture.runGit(['rev-parse', 'HEAD'])).trim());
      }

      const tree = (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
      const messages = await Promise.all(
        [...shas]
          .reverse()
          .map(async (sha) =>
            (
              await fixture.runGit(['show', '-s', '--format=%B', sha])
            ).trimEnd(),
          ),
      );
      const access = await getGitApi();
      const id = vscode.Uri.file(fixture.root).toString();

      await access.api.openRepository(vscode.Uri.file(fixture.root));
      await access.repository(id).status();
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      await expect
        .poll(async () => {
          for (const context of browser.contexts())
            for (const page of context.pages())
              for (const candidate of page.frames())
                if (
                  await candidate
                    .locator('[data-commit-row]')
                    .filter({ hasText: 'Menu Newest' })
                    .count()
                )
                  frame = candidate;

          return Boolean(frame);
        })
        .toBe(true);
      assert.ok(frame);
      const rows = frame.locator('[data-commit-row]');

      await expect(rows.first()).toContainText('Menu Newest');
      for (const [kind, name, ref] of [
        [
          'branch-from-commit',
          'menu-created-branch',
          'refs/heads/menu-created-branch',
        ],
        ['tag-from-commit', 'menu-created-tag', 'refs/tags/menu-created-tag'],
      ] as const) {
        // A reference popup may overlap this row after the previous native picker.
        await rows.last().press('Enter');
        await expect(frame.locator('#details')).toHaveAttribute(
          'aria-busy',
          'false',
        );
        const context = JSON.parse(
          (await rows.last().getAttribute('data-vscode-context')) ?? '{}',
        ) as Record<string, unknown>;

        pending = vscode.commands.executeCommand(`gitUI.${kind}`, context);
        void Promise.resolve(pending).catch(() => {});
        const input = workbench.locator('.quick-input-widget input:visible');

        await expect(input).toHaveCount(1);
        await input.fill(name);
        await input.press('Enter');
        await pending;
        assert.equal((await fixture.runGit(['rev-parse', ref])).trim(), base);
        assert.equal(
          (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
          shas[0],
        );
        assert.equal(
          (await fixture.runGit(['branch', '--show-current'])).trim(),
          'main',
        );
        await expect(frame.locator('#history')).not.toHaveAttribute(
          'inert',
          '',
        );
      }

      // Native dialogs can leave the pointer over an interactive reference popup.
      // This scenario verifies command routing; select through the keyboard instead.
      await rows.first().press('Enter');
      await rows.first().press('Shift+ArrowDown');
      await rows.nth(1).press('Shift+ArrowDown');
      await expect(
        frame.locator('[data-commit-row][aria-selected="true"]'),
      ).toHaveCount(3);
      await rows.first().evaluate((node) => {
        node.addEventListener(
          'contextmenu',
          (event) => event.preventDefault(),
          { once: true },
        );
        node.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
      });
      await expect(frame.locator('#details')).toContainText('Menu Newest');
      await expect(frame.locator('#details')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await expect(frame.locator('#history')).not.toHaveAttribute('inert', '');
      const context = JSON.parse(
        (await rows.first().getAttribute('data-vscode-context')) ?? '{}',
      ) as Record<string, unknown>;

      assert.deepEqual(context.commitShas, shas);
      assert.equal(context.commitSha, shas[0]);
      assert.equal(context.commitSelectionCount, 3);
      assert.equal(context.commitCanSquash, true);
      pending = vscode.commands.executeCommand(
        commandId('squash-commits'),
        context,
      );
      void Promise.resolve(pending).catch(() => {});
      const cancel = workbench.getByRole('button', {
        name: 'Cancel',
        exact: true,
      });

      await expect(cancel)
        .toBeVisible()
        .catch(async (error: unknown) => {
          await writeFile(
            '.artifacts/native-squash-menu-failure.json',
            JSON.stringify(
              {
                context,
                currentContext: await rows
                  .first()
                  .getAttribute('data-vscode-context'),
                status: await frame!.locator('#status').textContent(),
                historyBusy: await frame!
                  .locator('#history')
                  .getAttribute('aria-busy'),
                workbench: await workbench.locator('body').innerText(),
              },
              null,
              2,
            ),
          );
          throw error;
        });
      const draft = vscode.window.activeTextEditor!.document;

      assert.equal(draft.languageId, 'plaintext');
      assert.equal(
        vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview,
        false,
      );
      const draftedMessages = draft.getText();
      let previous = -1;

      for (const message of messages) {
        const position = draftedMessages.indexOf(message);

        assert.ok(
          position > previous,
          'full messages must appear oldest first',
        );
        previous = position;
      }

      await cancel.evaluate((node) => (node as HTMLElement).click());
      await pending;
      assert.equal(
        (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
        shas[0],
      );
      await expect(cancel).toHaveCount(0);
      // Each invocation must use a newly opened menu. Git discovery/status may
      // refresh the view while the preceding native editor was open.
      await rows.first().press('Enter');
      await rows.first().press('Shift+ArrowDown');
      await rows.nth(1).press('Shift+ArrowDown');
      await expect(frame.locator('#details')).toContainText('Menu Oldest');
      await rows.first().evaluate((node) => {
        node.addEventListener(
          'contextmenu',
          (event) => event.preventDefault(),
          { once: true },
        );
        node.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
      });
      await expect(frame.locator('#details')).toContainText('Menu Newest');
      await expect(frame.locator('#details')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await expect(frame.locator('#history')).not.toHaveAttribute('inert', '');
      const freshContext = JSON.parse(
        (await rows.first().getAttribute('data-vscode-context')) ?? '{}',
      ) as Record<string, unknown>;

      assert.deepEqual(freshContext.commitShas, shas);
      pending = vscode.commands.executeCommand(
        commandId('squash-commits'),
        freshContext,
      );
      void Promise.resolve(pending).catch(() => {});
      const apply = workbench.getByRole('button', {
        name: 'Apply',
        exact: true,
      });

      await expect(apply).toBeVisible();
      const approved = vscode.window.activeTextEditor!.document.getText();

      assert.equal(approved, draftedMessages);
      await apply.evaluate((node) => (node as HTMLElement).click());
      await pending;
      assert.equal(
        (await fixture.runGit(['rev-list', '--count', `${base}..HEAD`])).trim(),
        '1',
      );
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD^'])).trim(), base);
      assert.equal(
        (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim(),
        tree,
      );
      const object = await fixture.runGit(['cat-file', 'commit', 'HEAD']);

      assert.equal(object.slice(object.indexOf('\n\n') + 2), approved);
      assert.equal(await fixture.runGit(['status', '--porcelain=v1']), '');
      const extension = vscode.extensions.all.find(
        (entry) => entry.packageJSON.name === extensionIdentity.name,
      )!;
      const helper = join(extension.extensionPath, 'dist', 'squash-helper.cjs');
      const helperLocation = relative(extension.extensionPath, helper);

      assert.equal(helperLocation, join('dist', 'squash-helper.cjs'));
      if (process.env.GIT_UI_INSTALLED_ROOT) {
        const installed = relative(process.env.GIT_UI_INSTALLED_ROOT, helper);

        assert.ok(
          installed && !isAbsolute(installed) && !installed.startsWith('..'),
        );
      }

      const squashed = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

      for (const choice of ['Cancel', 'Drop']) {
        // Settle the preceding rewrite's native observations before capturing
        // the next range. A fresh generation must still contain its exact HEAD.
        await access.repository(id).status();
        await refreshNativeHistory(frame, id);
        await expect(rows.first()).toHaveAttribute('data-sha', squashed);
        await rows.first().press('Enter');
        await expect(frame.locator('#details')).toHaveAttribute(
          'aria-busy',
          'false',
        );
        const context = JSON.parse(
          (await rows.first().getAttribute('data-vscode-context')) ?? '{}',
        ) as Record<string, unknown>;

        assert.equal(context.commitCanDrop, true);
        pending = vscode.commands.executeCommand(
          commandId('drop-commits'),
          context,
        );
        void Promise.resolve(pending).catch(() => {});
        const button = workbench.getByRole('button', {
          name: choice,
          exact: true,
        });

        await expect(button)
          .toBeVisible()
          .catch(async (error: unknown) => {
            const state = {
              choice,
              context,
              currentContext: await rows
                .first()
                .getAttribute('data-vscode-context'),
              head: {
                expected: squashed,
                git: (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
                native: access.repository(id).state.HEAD?.commit ?? null,
              },
              status: await frame!.locator('#status').textContent(),
              busy: await frame!.locator('#history').getAttribute('inert'),
              workbench: (await workbench.locator('body').innerText()).slice(
                -3000,
              ),
            };

            throw new Error(
              `Drop review did not open: ${JSON.stringify(state)}`,
              { cause: error },
            );
          });
        await button.evaluate((node) => (node as HTMLElement).click());
        await pending;
        assert.equal(
          (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
          choice === 'Cancel' ? squashed : base,
        );
      }

      await expect(
        frame.locator('[data-commit-row][aria-selected="true"]'),
      ).toHaveAttribute('data-sha', base);
      assert.equal(
        (
          await fixture.runGit(['rev-parse', 'refs/heads/menu-created-branch'])
        ).trim(),
        base,
      );
      assert.equal(
        (
          await fixture.runGit(['rev-parse', 'refs/tags/menu-created-tag'])
        ).trim(),
        base,
      );
    } finally {
      try {
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await vscode.commands.executeCommand('notifications.clearAll');
        if (pending) await Promise.resolve(pending).catch(() => {});
      } finally {
        await Promise.all([drafts.dispose(), fixture.dispose()]);
      }
    }
  }).timeout(60000);
});
