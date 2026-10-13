import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import type { Frame } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import {
  commandId,
  EXTENSION_ID,
  extensionIdentity,
  LOG_VIEW_ID,
} from '../../src/shared/extension-identity';
import { nativeBrowser } from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';

describe('private package', () => {
  it('registered extension activates on the tested VS Code runtime', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);

    assert.ok(extension);
    await extension.activate();
    assert.equal(extension.isActive, true);
    if (process.env.GIT_UI_INSTALLED_ROOT) {
      const local = relative(
        process.env.GIT_UI_INSTALLED_ROOT,
        extension.extensionPath,
      );

      assert.ok(
        local && !isAbsolute(local) && !local.startsWith('..'),
        'must activate the installed VSIX, not development source',
      );
    }

    assert.equal(
      extension.packageJSON.displayName,
      extensionIdentity.displayName,
    );
    assert.equal(
      extension.packageJSON.contributes.viewsContainers.panel[0].title,
      extension.packageJSON.displayName,
    );
    assert.equal(
      extension.packageJSON.contributes.views[
        extensionIdentity.commandNamespace
      ][0].name,
      extension.packageJSON.displayName,
    );
    assert.equal(extension.packageJSON.engines.vscode, '^1.111.0');
    assert.equal(extension.packageJSON.private, true);
    assert.equal(extension.packageJSON.main, './dist/extension.cjs');
    await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
    const browser = await nativeBrowser();
    const workbench = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().includes('/workbench/workbench.html'));

    assert.ok(workbench);
    await expect(
      workbench.getByRole('tab', {
        name: extensionIdentity.displayName,
        exact: true,
      }),
    ).toBeVisible();
  });
  if (process.env.GIT_UI_INSTALLED_ROOT)
    it('installed bundle preserves geometry, context routing and native diffs', async () => {
      const browser = await nativeBrowser();
      let frame: Frame | undefined;

      for (let attempt = 0; attempt < 100 && !frame; attempt++) {
        for (const context of browser.contexts())
          for (const page of context.pages())
            for (const candidate of page.frames())
              if (await candidate.locator('#branches').count())
                frame = candidate;
        if (!frame) await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.ok(frame);
      await expect(frame.locator('#status')).toBeVisible();
      // Give the installed panel enough width to move both boundaries above their minima.
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand(
        'workbench.action.closeAuxiliaryBar',
      );
      const fixture = await createFixture({
        prefix: 'git-ui-native installed ',
      });
      let clipboard: string | undefined;

      try {
        clipboard = await vscode.env.clipboard.readText();
        await frame.evaluate(() => {
          const violations: string[] = [];
          const record = (event: SecurityPolicyViolationEvent) =>
            violations.push(event.violatedDirective);

          Reflect.set(window, 'packageCspViolations', violations);
          document.addEventListener('securitypolicyviolation', record);
          Reflect.set(window, 'stopPackageCspObservation', () =>
            document.removeEventListener('securitypolicyviolation', record),
          );
        });
        await fixture.runGit(['tag', 'v1']);
        await fixture.runGit(['branch', 'topic']);
        const head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

        await (
          await getGitApi()
        ).api.openRepository(vscode.Uri.file(fixture.root));
        await expect(frame.locator('[data-commit-row]').first()).toContainText(
          'Initial',
        );
        await expect(
          frame.getByRole('treeitem', {
            name: 'main (Current branch)',
            exact: true,
          }),
        ).toBeVisible();
        await frame
          .getByRole('treeitem', { name: 'All branches', exact: true })
          .evaluate((node) =>
            node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
          );
        await expect(frame.locator('#scope')).toHaveText('All branches');
        for (const [name, scope] of [
          ['topic', 'topic'],
          ['HEAD (Current Branch)', 'main'],
        ] as const) {
          await frame
            .getByRole('treeitem', { name, exact: true })
            .evaluate((node) =>
              node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
            );
          await expect(frame.locator('#scope')).toHaveText(scope);
          await expect(frame.locator('#history')).not.toHaveAttribute(
            'inert',
            '',
          );
          await expect(
            frame.locator('[data-commit-row]').first(),
          ).toContainText('Initial');
        }

        const row = frame.locator('[data-commit-row]').first();

        await expect(row).toBeVisible();
        await expect
          .poll(() =>
            row.evaluate((node) => node.getBoundingClientRect().height),
          )
          .toBe(22);
        const settings = frame.getByRole('button', { name: 'View options' });

        await settings.evaluate((node) => (node as HTMLElement).click());
        await frame
          .getByRole('button', { name: 'Columns', exact: true })
          .hover();
        for (const name of ['Author', 'Date', 'Hash'])
          await frame
            .getByRole('checkbox', { name, exact: true })
            .evaluate((node) => (node as HTMLInputElement).click());
        await settings.evaluate((node) => (node as HTMLElement).click());
        await expect(row.locator('[role=cell]')).toHaveCount(2);
        const compactBoundary = frame.getByRole('separator', {
          name: 'Resize Commit and Revision columns',
        });

        await expect(compactBoundary).toBeVisible();
        await compactBoundary.evaluate((node) =>
          node.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
          ),
        );
        await expect(row.locator('[data-revision]')).toBeVisible();
        await settings.evaluate((node) => (node as HTMLElement).click());
        await frame
          .getByRole('button', { name: 'Columns', exact: true })
          .hover();
        for (const name of ['Author', 'Date', 'Hash'])
          await frame
            .getByRole('checkbox', { name, exact: true })
            .evaluate((node) => (node as HTMLInputElement).click());
        await settings.evaluate((node) => (node as HTMLElement).click());
        await expect(row.locator('[role=cell]')).toHaveCount(3);
        const widths = () =>
          row.evaluate((node) =>
            [...node.children].map(
              (cell) => cell.getBoundingClientRect().width,
            ),
          );

        for (const name of [
          'Resize Commit and Author columns',
          'Resize Author and Date columns',
        ]) {
          const handle = frame.getByRole('separator', { name });

          await handle.hover({ position: { x: 2, y: 12 } });
          const bounds = await handle.boundingBox();

          assert.ok(bounds);
          const before = await widths();
          const side = name.startsWith('Resize Commit') ? 0 : 1;

          await frame.page().mouse.down();
          try {
            await expect
              .poll(() =>
                handle.evaluate((node) =>
                  (node as HTMLElement).hasPointerCapture(1),
                ),
              )
              .toBe(true);
            await frame
              .page()
              .mouse.move(bounds.x + 2 - 10, bounds.y + 12, { steps: 5 });
            await expect
              .poll(async () => (await widths())[side])
              .toBeCloseTo(before[side]! - 10, 0);
          } finally {
            await frame.page().mouse.up();
          }

          await expect
            .poll(async () => (await widths())[side])
            .toBeCloseTo(before[side]! - 10, 0)
            .catch(async (error: unknown) => {
              await writeFile(
                '.artifacts/installed-column-resize-failure.json',
                JSON.stringify({
                  name,
                  before,
                  after: await widths(),
                  bounds,
                  currentBounds: await handle.boundingBox(),
                  value: await handle.getAttribute('aria-valuenow'),
                  minimum: await handle.getAttribute('aria-valuemin'),
                }),
              );
              await frame!.page().screenshot({
                path: '.artifacts/installed-column-resize-failure.png',
              });
              throw error;
            });
        }

        await row.locator('[data-references]').hover();
        const tooltip = frame.getByRole('tooltip');

        await expect(tooltip).toBeVisible();
        await expect(tooltip).toContainText('HEAD');
        await expect(tooltip).toContainText('main');
        await expect(tooltip).toContainText('v1');
        await expect(tooltip).toContainText('Tag');
        assert.equal(
          await frame.evaluate(async () => {
            const fonts = await document.fonts.load('16px codicon');

            return (
              fonts.length > 0 &&
              fonts.every((font) => font.status === 'loaded')
            );
          }),
          true,
          'the packaged icon font must load under the real webview CSP',
        );
        const branch = frame.getByRole('treeitem', {
          name: 'topic',
          exact: true,
        });

        for (const [target, command, expected] of [
          [branch, commandId('copy-branch'), 'topic'],
          [row, commandId('copy-sha'), head],
        ] as const) {
          // Exercise the compiled handler and native command without opening an unattended OS menu.
          await target.evaluate((node) => {
            node.addEventListener(
              'contextmenu',
              (event) => event.preventDefault(),
              { once: true },
            );
            node.dispatchEvent(
              new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
              }),
            );
          });
          const context = await target.getAttribute('data-vscode-context');

          assert.ok(context);
          await vscode.commands.executeCommand(command, JSON.parse(context));
          assert.equal(await vscode.env.clipboard.readText(), expected);
        }

        const revision = frame
          .locator('[data-commit-info]')
          .getByText(head.slice(0, 8), { exact: true });

        await expect(revision).toHaveAttribute('title', head);
        const file = frame.locator('[data-path="sample.txt"]');

        await expect(file).toBeVisible();
        const icon = file.locator('[data-file-icon]');
        const iconSettings = vscode.workspace.getConfiguration('workbench');
        const previousIconTheme = iconSettings.inspect<string | null>(
          'iconTheme',
        )?.globalValue;

        try {
          await iconSettings.update(
            'iconTheme',
            'vs-seti',
            vscode.ConfigurationTarget.Global,
          );
          // A theme refresh can replace its stylesheet between separate reads.
          await expect
            .poll(
              () =>
                icon.evaluate(async (node) => {
                  const family = getComputedStyle(node, '::before').fontFamily;
                  const faces = await document.fonts.load('24px ' + family);

                  return {
                    family,
                    loaded:
                      faces.length > 0 &&
                      faces.every((face) => face.status === 'loaded'),
                  };
                }),
              {
                message:
                  'installed host serves the active Explorer font under the real CSP',
              },
            )
            .toMatchObject({
              family: /git-file-theme-.*-font-0/,
              loaded: true,
            });
          await iconSettings.update(
            'iconTheme',
            'vs-minimal',
            vscode.ConfigurationTarget.Global,
          );
          await expect(icon.locator('img')).toHaveAttribute(
            'src',
            /document-dark\.svg$/,
          );
          await expect
            .poll(() =>
              icon
                .locator('img')
                .evaluate((node) => (node as HTMLImageElement).naturalWidth),
            )
            .toBeGreaterThan(0);
          await expect(row).toHaveAttribute('aria-selected', 'true');
        } finally {
          await iconSettings.update(
            'iconTheme',
            previousIconTheme,
            vscode.ConfigurationTarget.Global,
          );
        }

        await file.evaluate((node) => (node as HTMLElement).click());
        const activeDiff = () =>
          vscode.window.tabGroups.all
            .flatMap((group) => group.tabs)
            .find(
              (tab) =>
                tab.isActive && tab.input instanceof vscode.TabInputTextDiff,
            );

        for (let attempt = 0; attempt < 100 && !activeDiff(); attempt++)
          await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(
          activeDiff()?.isPreview,
          'file click opens a native preview diff',
        );
        const input = activeDiff()!.input as vscode.TabInputTextDiff;

        assert.equal(input.modified.scheme, 'git');
        assert.ok(
          input.modified.query.includes(head),
          'native diff uses the selected full revision',
        );
        await file.evaluate((node) =>
          node.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Enter',
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
        for (
          let attempt = 0;
          attempt < 100 && activeDiff()?.isPreview;
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(
          activeDiff()?.isPreview,
          false,
          'Enter keeps the native diff in a regular tab',
        );
        assert.equal(
          (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
          head,
        );
        assert.deepEqual(
          await frame.evaluate(
            () => Reflect.get(window, 'packageCspViolations') as unknown,
          ),
          [],
        );
      } finally {
        try {
          if (!frame.isDetached())
            await frame.evaluate(() => {
              const stop = Reflect.get(window, 'stopPackageCspObservation') as
                (() => void) | undefined;

              stop?.();
              Reflect.deleteProperty(window, 'stopPackageCspObservation');
            });
          await vscode.commands.executeCommand(
            'workbench.action.closeAllEditors',
          );
          // Stop VS Code's Git watchers before deleting the fixture's files.
          await vscode.commands.executeCommand(
            'git.close',
            vscode.Uri.file(fixture.root),
          );
          assert.ok(
            !(await getGitApi()).api.repositories.some(
              (repository) => repository.rootUri.fsPath === fixture.root,
            ),
            'fixture repository is closed before its files are removed',
          );
        } finally {
          await Promise.all([
            ...(clipboard !== undefined
              ? [vscode.env.clipboard.writeText(clipboard)]
              : []),
            fixture.dispose(),
          ]);
        }
      }
    });
});
