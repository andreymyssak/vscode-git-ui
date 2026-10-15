import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CDPSession, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { sourceControlCommandId } from '../../src/shared/extension-identity';
import { createFixture } from '../fixtures/repository';
import { sourceControlFrame } from '../fixtures/source-control-view';

async function typography(label: Locator) {
  return label.evaluate((element) => {
    const style = getComputedStyle(element);

    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    };
  });
}

async function hoverSnapshot(hover: Locator, contentsSelector?: string) {
  return hover.evaluate((element, contentsSelector) => {
    if (!element.isConnected)
      throw new Error('Hover detached before its styles were captured.');
    const style = getComputedStyle(element);
    const contents = contentsSelector
      ? element.querySelector(contentsSelector)
      : element;

    if (!contents) throw new Error('Hover contents must be rendered.');

    return {
      text: (element as HTMLElement).innerText,
      appearance: {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        borderRadius: style.borderRadius,
        borderColor: style.borderColor,
        background: style.backgroundColor,
        color: style.color,
        padding: getComputedStyle(contents).padding,
      },
    };
  }, contentsSelector);
}

async function folderBadge(label: Locator, native: boolean) {
  return label.evaluate((element, native) => {
    const badge = native
      ? element.closest('.monaco-icon-label')
      : element.querySelector('[data-folder-status] .codicon');

    if (!badge) return null;
    const style = getComputedStyle(badge, native ? '::after' : null);

    if (native && !style.content.includes('\uea71')) return null;

    return {
      size: style.fontSize,
      color: style.color,
      opacity: style.opacity,
    };
  }, native);
}

async function revealNativeLabel(page: Page, label: Locator): Promise<void> {
  const list = page.locator('.scm-view .monaco-list').first();
  const focusedRow = list.locator('.monaco-list-row.focused');

  // Walk the tree: a virtual row cannot provide its index before it is rendered.
  await page.mouse.move(0, 0);
  await list.press('Home');
  await expect(focusedRow).toHaveCount(1);
  while (
    !(await label.count()) ||
    !(await label.evaluate((element) =>
      element.closest('.monaco-list-row')?.classList.contains('focused'),
    ))
  ) {
    if ((await focusedRow.getAttribute('aria-expanded')) === 'false') {
      await list.press('ArrowRight');
      await expect(focusedRow).toHaveAttribute('aria-expanded', 'true');
    }

    const value = await focusedRow.getAttribute('data-index');

    assert.ok(value !== null);
    const index = Number(value);

    assert.ok(Number.isInteger(index) && index >= 0);
    await list.press('ArrowDown');
    await expect
      .poll(async () =>
        (await focusedRow.count())
          ? Number(await focusedRow.getAttribute('data-index'))
          : -1,
      )
      .toBeGreaterThan(index);
  }

  await expect(label).toBeVisible();
}

describe('Source Control appearance', () => {
  it('matches native folder status dots and file hovers in light and dark themes', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-appearance-' });
    const workbench = vscode.workspace.getConfiguration('workbench');
    const delay = workbench.inspect<number>('hover.delay')?.globalValue;
    const previousTheme = workbench.inspect<string>('colorTheme')?.globalValue;
    const access = await getGitApi();
    const previousRepositories = access.api.repositories.map(
      (repository) => repository.rootUri,
    );
    let page: Page | undefined;
    let viewportSession: CDPSession | undefined;
    let hoverTarget: string | undefined;
    let panelWasVisible = false;

    try {
      await workbench.update(
        'hover.delay',
        100,
        vscode.ConfigurationTarget.Global,
      );
      for (const path of [
        'modified/sample.txt',
        'deleted/removed.txt',
        'renamed/old.txt',
        'staged/only.txt',
        'mixed/both.txt',
        'conflicted/both-edited.txt',
      ]) {
        await mkdir(dirname(join(fixture.root, path)), { recursive: true });
        await writeFile(join(fixture.root, path), `Original ${path}\n`);
      }

      await fixture.runGit(['add', '.']);
      await fixture.runGit(['commit', '-m', 'Hover fixtures']);
      await fixture.runGit(['checkout', '-b', 'conflict-side']);
      await writeFile(
        join(fixture.root, 'conflicted/both-edited.txt'),
        'Other branch\n',
      );
      await fixture.runGit(['commit', '-am', 'Other branch edit']);
      await fixture.runGit(['checkout', 'main']);
      await writeFile(
        join(fixture.root, 'conflicted/both-edited.txt'),
        'Current branch\n',
      );
      await fixture.runGit(['commit', '-am', 'Current branch edit']);
      await assert.rejects(fixture.runGit(['merge', 'conflict-side']));
      await writeFile(join(fixture.root, 'modified/sample.txt'), 'Changed\n');
      await mkdir(join(fixture.root, 'compact/deep'), { recursive: true });
      await writeFile(join(fixture.root, 'compact/deep/new.txt'), 'New\n');
      await unlink(join(fixture.root, 'deleted/removed.txt'));
      await fixture.runGit(['mv', 'renamed/old.txt', 'renamed/new-name.txt']);
      for (const path of ['staged/only.txt', 'mixed/both.txt'])
        await writeFile(join(fixture.root, path), `Staged ${path}\n`);
      await fixture.runGit(['add', 'staged/only.txt', 'mixed/both.txt']);
      await writeFile(
        join(fixture.root, 'mixed/both.txt'),
        'Working changes\n',
      );

      const cases = [
        { path: 'modified/sample.txt', name: 'sample.txt' },
        { path: 'compact/deep/new.txt', name: 'new.txt' },
        { path: 'deleted/removed.txt', name: 'removed.txt' },
        { path: 'renamed/new-name.txt', name: 'new-name.txt' },
        { path: 'staged/only.txt', name: 'only.txt' },
        { path: 'mixed/both.txt', name: 'both.txt' },
        { path: 'conflicted/both-edited.txt', name: 'both-edited.txt' },
        { path: 'modified', name: 'modified' },
        { path: 'compact/deep', name: 'deep' },
        { path: 'deleted', name: 'deleted' },
        { path: 'staged', name: 'staged' },
        { path: 'conflicted', name: 'conflicted' },
      ];

      // Native SCM virtualizes its rows; earlier fixtures can push this one out of view.
      for (const uri of previousRepositories)
        await vscode.commands.executeCommand('git.close', uri);
      const repository = await access.api.openRepository(
        vscode.Uri.file(fixture.root),
      );

      assert.ok(repository);
      await repository.status();
      await vscode.commands.executeCommand(
        sourceControlCommandId('refresh-changes'),
      );
      const frame = await sourceControlFrame();

      page = frame.page();
      assert.equal(page.viewportSize(), null);
      viewportSession = await page.context().newCDPSession(page);
      // Hosted desktops can be too short to render all native SCM rows at once.
      await viewportSession.send('Emulation.setDeviceMetricsOverride', {
        width: 1024,
        height: 600,
        deviceScaleFactor: await page.evaluate(() => window.devicePixelRatio),
        mobile: false,
      });
      panelWasVisible = await page.locator('.part.panel').isVisible();
      await vscode.commands.executeCommand('workbench.action.closePanel');
      const comparisons = [];
      const themes = [
        { name: 'Default Dark Modern', bodyClass: 'vscode-dark' },
        { name: 'Default Light Modern', bodyClass: 'vscode-light' },
      ];

      for (const theme of themes) {
        await workbench.update(
          'colorTheme',
          theme.name,
          vscode.ConfigurationTarget.Global,
        );
        await expect(frame.locator('body')).toHaveClass(
          new RegExp(theme.bodyClass),
        );
        for (const { path, name } of cases) {
          const section = [
            'renamed/new-name.txt',
            'staged/only.txt',
            'staged',
          ].includes(path)
            ? 'Staged Changes'
            : path.startsWith('conflicted')
              ? 'Merge Changes'
              : 'Changes';
          const customRow = frame
            .getByRole('tree', { name: section, exact: true })
            .getByRole('treeitem', {
              name: path,
              exact: true,
            });
          const customLabel = customRow
            .locator(':scope > span')
            .filter({ hasText: name })
            .first();

          await page.mouse.move(0, 0);
          await customLabel.hover({ timeout: 5000 });
          const customHover = frame.getByRole('tooltip');

          await expect(customHover).toBeVisible();
          const snapshot = await hoverSnapshot(customHover);

          comparisons.push({
            name,
            path,
            theme: theme.name,
            typography: await typography(customLabel),
            ...snapshot,
            badge:
              (await customRow.getAttribute('aria-expanded')) !== null
                ? await folderBadge(customRow, false)
                : undefined,
          });
          await page.keyboard.press('Escape');
        }
      }

      const changes = page.getByRole('button', {
        name: 'Changes Section',
        exact: true,
      });
      const customSection = page.getByRole('button', {
        name: 'Git UI Changes Section',
        exact: true,
      });

      if ((await customSection.getAttribute('aria-expanded')) === 'true')
        await customSection.locator('.twisty-container').click();

      if ((await changes.getAttribute('aria-expanded')) !== 'true')
        await changes.locator('.twisty-container').click();
      await vscode.commands.executeCommand(
        'workbench.scm.action.setTreeViewMode',
      );
      await expect(
        page.locator('.scm-view .monaco-list').first(),
      ).toBeVisible();
      await page.locator('.scm-view .monaco-list').first().focus();
      const native = [];
      let nativeTheme: string | undefined;

      for (const comparison of comparisons) {
        hoverTarget = comparison.path;
        if (nativeTheme !== comparison.theme) {
          await workbench.update(
            'colorTheme',
            comparison.theme,
            vscode.ConfigurationTarget.Global,
          );
          await expect(page.locator('.monaco-workbench')).toHaveClass(
            comparison.theme === 'Default Dark Modern'
              ? /\bvs-dark\b/
              : /(?:^|\s)vs(?:\s|$)/,
          );
          nativeTheme = comparison.theme;
        }

        const nativeLabel = page
          .locator('.scm-view .monaco-list-row .monaco-icon-label')
          .getByText(comparison.name, { exact: true })
          .first();

        await page.bringToFront();
        await page.locator('.scm-view .monaco-list').first().focus();
        await page.mouse.move(0, 0);
        await revealNativeLabel(page, nativeLabel);
        const labelTypography = await typography(nativeLabel);
        const badge =
          comparison.badge !== undefined
            ? await folderBadge(nativeLabel, true)
            : undefined;

        const nativeHover = page
          .locator('.monaco-hover.workbench-hover')
          .filter({ visible: true });
        let snapshot: Awaited<ReturnType<typeof hoverSnapshot>> | undefined;

        // Native theme redraws can detach a hover between locator resolution and
        // capture. Reopen and read it until the reference has rendered styles.
        await expect(async () => {
          await vscode.commands.executeCommand('list.showHover');
          const rendered = await hoverSnapshot(nativeHover, '.hover-contents');

          expect(rendered.text).toContain(join(fixture.root, comparison.path));
          expect(Object.values(rendered.appearance)).not.toContain('');
          snapshot = rendered;
        }).toPass({ timeout: 5000 });
        assert.ok(snapshot);
        native.push({
          name: comparison.name,
          path: comparison.path,
          theme: comparison.theme,
          typography: labelTypography,
          ...snapshot,
          badge,
        });
        await page.keyboard.press('Escape');
        await page.mouse.move(0, 0);
        await expect(nativeHover).toHaveCount(0);
      }

      assert.deepEqual(comparisons, native);
    } catch (error) {
      await page?.screenshot({
        path: join(
          process.env.GIT_UI_TEST_ARTIFACTS ?? '.artifacts',
          'source-control-appearance-failure.png',
        ),
      });
      await writeFile(
        join(
          process.env.GIT_UI_TEST_ARTIFACTS ?? '.artifacts',
          'source-control-appearance-diagnostic.json',
        ),
        JSON.stringify({
          hoverTarget,
          theme: vscode.workspace
            .getConfiguration('workbench')
            .get('colorTheme'),
          focusedRow: await page
            ?.locator('.scm-view .monaco-list-row.focused')
            .allTextContents(),
          activeElement: await page?.evaluate(() => ({
            tag: document.activeElement?.tagName,
            class: document.activeElement?.className,
            focused: document.hasFocus(),
          })),
          labels: await page
            ?.locator('.scm-view .monaco-list-row .monaco-icon-label')
            .allTextContents(),
          text: await page?.locator('body').innerText(),
        }),
      );
      throw error;
    } finally {
      try {
        await page?.keyboard.press('Escape');
        const changes = page?.getByRole('button', {
          name: 'Changes Section',
          exact: true,
        });

        if (changes && (await changes.getAttribute('aria-expanded')) === 'true')
          await changes.locator('.twisty-container').click();
        await vscode.commands.executeCommand(
          'git.close',
          vscode.Uri.file(fixture.root),
        );
        await fixture.dispose();
        for (const uri of previousRepositories)
          if (existsSync(uri.fsPath)) await access.api.openRepository(uri);
        await vscode.commands.executeCommand(
          sourceControlCommandId('refresh-changes'),
        );
        await workbench.update(
          'hover.delay',
          delay,
          vscode.ConfigurationTarget.Global,
        );
        await workbench.update(
          'colorTheme',
          previousTheme,
          vscode.ConfigurationTarget.Global,
        );
        if (panelWasVisible)
          await vscode.commands.executeCommand('workbench.action.focusPanel');
      } finally {
        if (viewportSession) {
          try {
            await viewportSession.send('Emulation.clearDeviceMetricsOverride');
          } finally {
            await viewportSession.detach();
          }
        }
      }
    }
  }).timeout(60000);
});
