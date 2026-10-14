import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Frame } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { safeIconResource } from '../../src/extension/panel/file-icon-host';
import { EXTENSION_ID, LOG_VIEW_ID } from '../../src/shared/extension-identity';
import { nativeBrowser } from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';

describe('installed file icon themes', () => {
  it('Seti fonts and Minimal images load under the native policy while live theme changes preserve the document', async () => {
    const fixture = await createFixture({
      prefix: 'git-ui-native file-icons ',
    });
    const configuration = vscode.workspace.getConfiguration('workbench');
    const scmConfiguration = vscode.workspace.getConfiguration('scm');
    const previousViewMode =
      scmConfiguration.inspect('defaultViewMode')?.globalValue;
    const previousIcon = configuration.inspect('iconTheme')?.globalValue;
    const previousColor = configuration.inspect('colorTheme')?.globalValue;
    const extension = vscode.extensions.getExtension(EXTENSION_ID);

    try {
      assert.ok(extension);
      await extension.activate();
      await mkdir(join(fixture.root, 'src'));
      await writeFile(
        join(fixture.root, 'src/file.ts'),
        'export const file = 1;\n',
      );
      await fixture.runGit(['add', '.']);
      await fixture.runGit(['commit', '-m', 'Icon theme fixture']);
      const repository = await (
        await getGitApi()
      ).api.openRepository(vscode.Uri.file(fixture.root));

      assert.ok(repository);
      await writeFile(
        join(fixture.root, 'src/file.ts'),
        'export const file = 2;\n',
      );
      await repository.status();
      await vscode.window.showTextDocument(
        vscode.Uri.file(join(fixture.root, 'src/file.ts')),
      );
      await configuration.update(
        'iconTheme',
        'vs-seti',
        vscode.ConfigurationTarget.Global,
      );
      await configuration.update(
        'colorTheme',
        'Default Dark Modern',
        vscode.ConfigurationTarget.Global,
      );
      await scmConfiguration.update(
        'defaultViewMode',
        'tree',
        vscode.ConfigurationTarget.Global,
      );
      await vscode.commands.executeCommand('workbench.view.scm');
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      const browser = await nativeBrowser();
      const workbench = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().includes('/workbench/workbench.html'));

      assert.ok(workbench);
      let frame: Frame | undefined;

      for (let attempt = 0; attempt < 100 && !frame; attempt++) {
        for (const context of browser.contexts())
          for (const page of context.pages())
            for (const candidate of page.frames())
              if (
                (await candidate.locator('#branches').count()) &&
                (
                  await candidate
                    .locator('[data-commit-row]')
                    .first()
                    .textContent()
                )?.includes('Icon theme fixture')
              )
                frame = candidate;
        if (!frame) await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.ok(frame);
      await expect(frame.locator('[data-commit-row]').first()).toContainText(
        'Icon theme fixture',
      );
      await frame
        .locator('[data-commit-row]')
        .first()
        .evaluate((node) => (node as HTMLElement).click());
      const file = frame.locator('[data-path="src/file.ts"]');
      const icon = file.locator('[data-file-icon]');

      await expect(file).toBeVisible();
      await expect
        .poll(() =>
          icon.evaluate((node) => getComputedStyle(node, '::before').content),
        )
        .toBe('"\ue099"');
      const family = await icon.evaluate(async (node) => {
        const style = getComputedStyle(node, '::before');
        const font = style.fontSize + ' ' + style.fontFamily;

        await document.fonts.load(font);

        return {
          family: style.fontFamily,
          loaded: document.fonts.check(font),
          size: parseFloat(style.fontSize),
        };
      });

      assert.match(family.family, /git-file-theme-.*-font-0/);
      assert.equal(family.loaded, true);

      assert.ok(
        (await vscode.commands.getCommands()).includes('workbench.scm.focus'),
      );
      await vscode.commands.executeCommand('workbench.scm.focus');
      const nativeIcon = workbench
        .locator('.scm-view .resource .monaco-icon-label')
        .filter({ hasText: 'file.ts' })
        .last();

      await expect(nativeIcon).toBeVisible();
      const nativeTextSize = await nativeIcon.evaluate((node) =>
        parseFloat(getComputedStyle(node).fontSize),
      );

      assert.equal(
        family.size,
        nativeTextSize * 1.5,
        'Seti scales from the native label font, independently of the icon slot',
      );

      assert.equal(
        await nativeIcon.evaluate(
          (node) => getComputedStyle(node, '::before').backgroundSize,
        ),
        '16px',
      );
      const nativeOffset = await nativeIcon.evaluate(
        (node) =>
          node.querySelector('.label-name')!.getBoundingClientRect().x -
          node.getBoundingClientRect().x,
      );
      const offset = await file.evaluate(
        (node) =>
          node
            .querySelector(':scope > span:nth-child(3)')!
            .getBoundingClientRect().x -
          node.querySelector('[data-file-icon]')!.getBoundingClientRect().x,
      );

      assert.equal(
        offset,
        nativeOffset,
        'File name offset matches native Source Control',
      );
      await expect(icon).toHaveCSS('width', '16px');
      await expect(icon).toHaveCSS('height', '22px');
      await expect(file.locator(':scope > span').nth(2)).toHaveCSS(
        'color',
        await workbench
          .locator('.scm-view:not(.scm-history-view)')
          .evaluate((node) => getComputedStyle(node).color),
      );
      await frame.evaluate(() =>
        Object.defineProperty(window, 'iconAcceptanceDocument', {
          value: document,
        }),
      );
      await file.evaluate((node) => (node as HTMLElement).click());
      await expect(file).toHaveAttribute('aria-selected', 'true');
      await frame
        .getByRole('treeitem', { name: 'src 1 file' })
        .locator(':scope > span')
        .first()
        .evaluate((node) => (node as HTMLElement).click());
      await configuration.update(
        'iconTheme',
        'vs-minimal',
        vscode.ConfigurationTarget.Global,
      );
      const image = icon.locator('img');

      await expect(image).toHaveAttribute('src', /document-dark\.svg/);
      await expect(image).toHaveCSS('width', '16px');
      await expect(image).toHaveCSS('height', '16px');
      await expect
        .poll(() =>
          image.evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      await expect(file).toHaveAttribute('aria-selected', 'true');
      await expect(frame.locator('[data-folder="src"]')).not.toHaveAttribute(
        'open',
        '',
      );
      assert.equal(
        await frame.evaluate(
          () =>
            (window as unknown as { iconAcceptanceDocument: Document })
              .iconAcceptanceDocument === document,
        ),
        true,
      );
      await frame
        .getByRole('treeitem', { name: 'src 1 file' })
        .locator(':scope > span')
        .first()
        .evaluate((node) => (node as HTMLElement).click());
      const nativeFolder = workbench
        .locator('.scm-view .monaco-icon-label.folder-icon')
        .filter({ hasText: 'src' })
        .last();

      await expect(nativeFolder).toBeVisible();
      const scopeIndent = await nativeFolder.evaluate((node) => {
        const level = Number(
          node.closest('.monaco-list-row')!.getAttribute('aria-level'),
        );

        // Native SCM adds a repository ancestor when other fixture repositories are open.
        return (level - 2) * 8;
      });

      for (const [ours, native] of [
        [file, nativeIcon],
        [frame.getByRole('treeitem', { name: 'src 1 file' }), nativeFolder],
      ] as const) {
        const actual = await ours.evaluate((node) => ({
          icon:
            node.querySelector('[data-file-icon]')!.getBoundingClientRect().x -
            node.getBoundingClientRect().x,
          text:
            node
              .querySelector(':scope > span:nth-child(3)')!
              .getBoundingClientRect().x - node.getBoundingClientRect().x,
        }));
        const expected = await native.evaluate(
          (node, scopeIndent) => ({
            icon:
              node.getBoundingClientRect().x -
              node.closest('.monaco-list-row')!.getBoundingClientRect().x -
              scopeIndent,
            text:
              node.querySelector('.label-name')!.getBoundingClientRect().x -
              node.closest('.monaco-list-row')!.getBoundingClientRect().x -
              scopeIndent,
          }),
          scopeIndent,
        );

        assert.deepEqual(
          actual,
          expected,
          'Full row icon/name offsets match native Source Control',
        );
      }

      await configuration.update(
        'colorTheme',
        'Default Light Modern',
        vscode.ConfigurationTarget.Global,
      );
      await expect(image).toHaveAttribute('src', /document-light\.svg/);
      await configuration.update(
        'iconTheme',
        'vs-seti',
        vscode.ConfigurationTarget.Global,
      );
      await expect
        .poll(() =>
          icon.evaluate((node) => getComputedStyle(node, '::before').color),
        )
        .toBe('rgb(73, 139, 167)');
    } finally {
      try {
        await vscode.commands.executeCommand(
          'workbench.action.closeAllEditors',
        );
      } finally {
        await Promise.all([
          scmConfiguration.update(
            'defaultViewMode',
            previousViewMode,
            vscode.ConfigurationTarget.Global,
          ),
          configuration.update(
            'iconTheme',
            previousIcon,
            vscode.ConfigurationTarget.Global,
          ),
          configuration.update(
            'colorTheme',
            previousColor,
            vscode.ConfigurationTarget.Global,
          ),
          fixture.dispose(),
        ]);
      }
    }
  });

  it('an installed-extension asset symlink cannot escape its owning directory', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-native icon-root ' });

    try {
      await mkdir(join(fixture.root, 'owner'));
      await writeFile(join(fixture.root, 'outside.svg'), '<svg/>');
      await symlink(
        join(fixture.root, 'outside.svg'),
        join(fixture.root, 'owner/icon.svg'),
      );
      assert.equal(
        await safeIconResource(
          vscode.Uri.file(join(fixture.root, 'owner')),
          'icon.svg',
        ),
        null,
      );
    } finally {
      await fixture.dispose();
    }
  });
});
