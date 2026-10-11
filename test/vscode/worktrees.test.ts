import assert from 'node:assert/strict';
import { realpath, rm, stat, writeFile } from 'node:fs/promises';

import {
  type BrowserContext,
  type Disposable,
  expect,
  type Frame,
} from '@playwright/test';
import * as vscode from 'vscode';

import type { GitAdapter } from '../../src/extension/git/adapter';
import { createGitAdapter } from '../../src/extension/git/adapter';
import { getGitApi } from '../../src/extension/git/api';
import { openWorktree } from '../../src/extension/native/worktrees';
import { LOG_VIEW_ID } from '../../src/shared/extension-identity';
import {
  nativeBrowser,
  refreshNativeHistory,
  selectNativeRepository,
} from '../fixtures/native-panel';
import { createFixture, disposeFixtureDirectory } from '../fixtures/repository';

describe('existing worktrees', () => {
  it('current marker follows root rather than main flag and detached worktree is labeled', async () => {
    const f = await createFixture({ prefix: 'git-ui-native worktrees ü ' });
    let adapter: GitAdapter | undefined;
    const linked = f.root + '.linked';
    const detached = f.root + '.detached';

    try {
      adapter = await createGitAdapter();
      await f.runGit(['worktree', 'add', '-b', 'linked', linked]);
      await f.runGit(['worktree', 'add', '--detach', detached]);
      const access = await getGitApi();

      await access.api.openRepository(vscode.Uri.file(f.root));
      await access.api.openRepository(vscode.Uri.file(linked));
      const main = await adapter.worktrees(vscode.Uri.file(f.root).toString());

      assert.equal(main.filter((w) => w.current).length, 1);
      assert.equal(
        await realpath(
          vscode.Uri.parse(main.find((w) => w.current)!.rootUri).fsPath,
        ),
        await realpath(f.root),
      );
      const fromLinked = await adapter.worktrees(
        vscode.Uri.file(linked).toString(),
      );

      assert.equal(fromLinked.find((w) => w.current)?.branch, 'linked');
      const detachedInfo = fromLinked.find((w) => w.branch === null);

      assert.ok(detachedInfo);
      const calls: { uri: vscode.Uri; options: unknown }[] = [];
      const capture = async (uri: vscode.Uri, options: unknown) => {
        calls.push({ uri, options });
      };

      await openWorktree(detachedInfo, 'new', capture);
      assert.deepEqual(calls[0]?.options, { forceNewWindow: true });
      await openWorktree(detachedInfo, 'current', capture);
      assert.deepEqual(calls[1]?.options, { forceReuseWindow: true });
      assert.equal(
        calls[1]?.uri.fsPath,
        vscode.Uri.parse(detachedInfo.rootUri).fsPath,
      );
      await rm(detached, { recursive: true, force: true, maxRetries: 5 });
      const missing = await adapter.worktrees(
        vscode.Uri.file(f.root).toString(),
      );

      assert.equal(
        missing.find((w) => w.rootUri === detachedInfo.rootUri)?.available,
        false,
      );
      await assert.rejects(
        () => openWorktree(detachedInfo, 'new', capture),
        /unavailable.*Refresh/,
      );
      assert.equal(calls.length, 2);
    } finally {
      adapter?.dispose();
      await f.dispose();
      await disposeFixtureDirectory(linked);
      await disposeFixtureDirectory(detached);
    }
  });

  it('native worktrees create through the plus button and preserve selection after refreshing', async () => {
    const fixture = await createFixture({
      prefix: 'git-ui-native worktree table ',
    });
    const linked = fixture.root + '.linked';
    const second = fixture.root + '.second';
    const created = fixture.root + '.created';
    let frame: Frame | undefined;

    try {
      await fixture.runGit(['worktree', 'add', '-b', 'linked', linked]);
      await fixture.runGit(['branch', 'topic']);
      const access = await getGitApi();
      const uri = vscode.Uri.file(fixture.root);

      await access.api.openRepository(uri);
      await access.repository(uri.toString()).status();
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      const browser = await nativeBrowser();

      frame = await selectNativeRepository(uri.toString());
      await frame.page().bringToFront();
      await vscode.commands.executeCommand('notifications.hideToasts');
      await frame
        .getByRole('tab', { name: 'Worktrees', exact: true })
        .click({ timeout: 5000 });
      const grid = frame.getByRole('grid', { name: 'Existing worktrees' });

      await expect(grid.getByRole('columnheader')).toHaveText([
        'Worktree',
        'Branch',
        'Path',
      ]);
      await expect(grid.locator('[data-current="true"]')).toContainText('main');
      const row = grid.locator('[data-worktree]').filter({
        has: frame.getByRole('gridcell', { name: 'linked', exact: true }),
      });

      await row.click({ timeout: 5000 });
      const cells = row.getByRole('gridcell');

      await expect(cells).toHaveCount(3);
      await expect(cells.nth(2)).toHaveText(
        (await realpath(linked)).replaceAll('\\', '/'),
      );
      const toolbar = frame.getByRole('toolbar', { name: 'Worktree actions' });

      assert.deepEqual(
        await toolbar
          .getByRole('button')
          .evaluateAll((buttons) =>
            buttons.map((button) => button.getAttribute('aria-label')),
          ),
        ['Refresh Worktrees', 'Create Worktree'],
      );
      await toolbar.getByRole('button', { name: 'Create Worktree' }).click();
      const workbench = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().includes('/workbench/workbench.html'))!;
      const picker = workbench.locator('.quick-input-widget');
      const input = picker.locator('input:visible');

      await expect(picker).toContainText('Create Worktree');
      await input.fill('topic');
      await input.press('Enter');
      await expect(picker).toContainText('New Worktree from "topic"');
      await input.press('Enter');
      await expect(picker).toContainText('Worktree Folder');
      await input.fill(created);
      await input.press('Enter');
      await expect(
        grid.getByRole('gridcell', { name: 'topic', exact: true }),
      ).toBeVisible();
      assert.ok(await stat(created));
      assert.equal(
        (
          await fixture.runGit(['-C', created, 'branch', '--show-current'])
        ).trim(),
        'topic',
      );
      await vscode.commands.executeCommand('notifications.hideToasts');
      await fixture.runGit(['worktree', 'add', '-b', 'second', second]);
      await toolbar
        .getByRole('button', { name: 'Refresh Worktrees' })
        .click({ timeout: 5000 });
      await expect(
        grid.getByRole('gridcell', { name: 'second', exact: true }),
      ).toBeVisible();
      await expect(row).toHaveAttribute('aria-selected', 'true');
      await expect(
        frame.getByRole('tab', { name: 'Log', exact: true }),
      ).toContainText('main');
      await frame
        .page()
        .screenshot({ path: '.artifacts/worktree-refinement-native.png' });
      assert.equal(
        (await fixture.runGit(['branch', '--show-current'])).trim(),
        'main',
      );
    } finally {
      if (frame)
        await frame
          .getByRole('tab', { name: 'Log', exact: true })
          .click({ timeout: 1000 })
          .catch(() => {});
      await disposeFixtureDirectory(linked);
      await disposeFixtureDirectory(second);
      await disposeFixtureDirectory(created);
      await fixture.dispose();
    }
  });
  it('native creation picker cancels without changes and Terminal return paints only Worktrees', async () => {
    const f = await createFixture({
      prefix: 'git-ui-native worktree lifecycle ',
    });
    const linked = f.root + '.linked';
    let frame: Frame | undefined;
    let observedContext: BrowserContext | undefined;
    let initScript: Disposable | undefined;
    let binding: Disposable | undefined;

    try {
      await f.runGit(['worktree', 'add', '-b', 'linked', linked]);
      const access = await getGitApi();
      const uri = vscode.Uri.file(f.root);

      await access.api.openRepository(uri);
      await access.repository(uri.toString()).status();
      await vscode.window.showTextDocument(
        vscode.Uri.joinPath(uri, 'sample.txt'),
      );
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      const browser = await nativeBrowser();
      const findFrame = async () => {
        for (const context of browser.contexts())
          for (const page of context.pages())
            for (const candidate of page.frames())
              if (
                await candidate
                  .locator('#worktrees-view')
                  .count()
                  .catch(() => 0)
              )
                return candidate;

        return undefined;
      };

      frame = await selectNativeRepository(uri.toString());
      await frame.page().bringToFront();
      await refreshNativeHistory(frame, uri.toString());
      await frame.getByRole('tab', { name: 'Worktrees', exact: true }).click();
      const row = frame.locator('[data-worktree]').filter({
        has: frame.getByRole('gridcell', { name: 'linked', exact: true }),
      });

      await row.click();
      await frame
        .getByRole('button', { name: 'Create Worktree', exact: true })
        .click();
      const workbench = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().includes('/workbench/workbench.html'))!;
      const picker = workbench.locator('.quick-input-widget');

      await expect(picker).toContainText('Create Worktree');
      await expect(picker).toContainText('main');
      await expect(picker).toContainText('Current branch');
      await expect(picker).toContainText('linked');
      const before = await f.runGit(['worktree', 'list', '--porcelain']);

      await workbench.keyboard.press('Escape');
      await expect(picker).toBeHidden();
      await expect(row).toHaveAttribute('aria-selected', 'true');
      assert.equal(await f.runGit(['worktree', 'list', '--porcelain']), before);
      assert.equal(
        access.repository(uri.toString()).rootUri.toString(),
        uri.toString(),
      );

      // VS Code recreates webview targets. Own context-wide scripts and bindings
      // through removable handles, with paint observations stored outside those documents.
      const selections: string[] = [];
      const traceTabs = () => {
        let animation = 0;
        const paint = () => {
          const contents = [
            document,
            ...[...document.querySelectorAll('iframe')]
              .map((iframe) => iframe.contentDocument)
              .filter((content) => content !== null),
          ];
          const record = Reflect.get(window, 'recordWorktreeTabPaint') as
            ((label: string) => Promise<void>) | undefined;

          for (const content of contents) {
            const selected = content.querySelector(
              '#log-tab[aria-selected="true"], #worktrees-tab[aria-selected="true"]',
            );
            const label = selected?.getAttribute('aria-label');

            if (label && !document.hidden) void record?.(label).catch(() => {});
          }

          animation = requestAnimationFrame(paint);
        };

        animation = requestAnimationFrame(paint);
        Reflect.set(window, 'stopWorktreeTabObservation', () => {
          cancelAnimationFrame(animation);
        });
      };

      observedContext = frame.page().context();
      binding = await observedContext.exposeBinding(
        'recordWorktreeTabPaint',
        (_source, label: string) => {
          if (selections.at(-1) !== label) selections.push(label);
        },
      );
      initScript = await observedContext.addInitScript(traceTabs);
      const parent = frame.parentFrame();

      assert.ok(parent);
      await parent.evaluate(traceTabs);
      await expect.poll(() => selections.length).toBeGreaterThan(0);
      await vscode.commands.executeCommand('workbench.action.terminal.focus');
      await expect(
        workbench.locator('.terminal-wrapper').first(),
      ).toBeVisible();
      selections.length = 0;
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      await expect
        .poll(async () => {
          frame = await findFrame();

          return (
            !!frame &&
            (await frame
              .getByRole('tab', { name: 'Worktrees', exact: true })
              .getAttribute('aria-selected')) === 'true'
          );
        })
        .toBe(true);
      assert.ok(frame);
      await expect(
        frame.locator('[data-worktree][data-current="true"]'),
      ).toBeVisible();
      await expect.poll(() => selections.length).toBeGreaterThan(0);
      assert.deepEqual([...new Set(selections)], ['Worktrees']);
      await frame
        .page()
        .screenshot({ path: '.artifacts/worktree-opening-native.png' });
    } finally {
      try {
        try {
          await initScript?.dispose();
        } finally {
          try {
            if (observedContext)
              await Promise.all(
                observedContext
                  .pages()
                  .flatMap((page) => page.frames())
                  .map(async (candidate) => {
                    if (candidate.isDetached()) return;
                    await candidate
                      .evaluate(() => {
                        const stop = Reflect.get(
                          window,
                          'stopWorktreeTabObservation',
                        ) as (() => void) | undefined;

                        stop?.();
                        Reflect.deleteProperty(
                          window,
                          'stopWorktreeTabObservation',
                        );
                      })
                      .catch((error: unknown) => {
                        if (!candidate.isDetached()) throw error;
                      });
                  }),
              );
          } finally {
            await binding?.dispose();
          }
        }
      } finally {
        if (frame)
          await frame
            .getByRole('tab', { name: 'Log', exact: true })
            .click({ timeout: 1000 })
            .catch(() => {});
        await disposeFixtureDirectory(linked);
        await f.dispose();
      }
    }
  });

  it('native worktree menus protect the current checkout and delete a Shift-selected group after confirmation', async () => {
    const f = await createFixture({
      prefix: 'git-ui-native native worktree deletion ',
    });
    const alpha = f.root + '.alpha';
    const beta = f.root + '.beta';
    const menu = vscode.workspace.getConfiguration('window');
    const previous = menu.inspect<string>('menuStyle')?.globalValue;
    let frame: Frame | undefined;

    try {
      await menu.update(
        'menuStyle',
        'custom',
        vscode.ConfigurationTarget.Global,
      );
      await f.runGit(['worktree', 'add', '-b', 'alpha', alpha]);
      await f.runGit(['worktree', 'add', '-b', 'beta', beta]);
      await writeFile(f.root + '/local.txt', 'Preserve current work');
      const uri = vscode.Uri.file(f.root);
      const access = await getGitApi();

      await access.api.openRepository(uri);
      await access.repository(uri.toString()).status();
      await vscode.window.showTextDocument(
        vscode.Uri.joinPath(uri, 'sample.txt'),
      );
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      const browser = await nativeBrowser();

      frame = await selectNativeRepository(uri.toString());
      await frame.page().bringToFront();
      await refreshNativeHistory(frame, uri.toString());
      await frame.getByRole('tab', { name: 'Worktrees', exact: true }).click();
      const toolbar = frame.getByRole('toolbar', { name: 'Worktree actions' });
      const current = frame.locator('[data-worktree][data-current="true"]');

      await current.click();
      await expect(
        toolbar.getByRole('button', { name: 'Create Worktree' }),
      ).toBeEnabled();
      const currentContext = JSON.parse(
        (await current.getAttribute('data-vscode-context'))!,
      );

      assert.equal(currentContext.worktreeCanOpen, false);
      assert.equal(currentContext.worktreeCanDelete, false);
      const row = (name: string) =>
        frame!
          .locator('[data-worktree]')
          .filter({ has: frame!.getByRole('gridcell', { name, exact: true }) });

      await row('alpha').click();
      await row('beta').click({ modifiers: ['Shift'] });
      await row('beta').click({ button: 'right' });
      const workbench = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().includes('/workbench/workbench.html'))!;
      const deletion = workbench.getByRole('menuitem', {
        name: 'Delete',
        exact: true,
      });

      await expect(deletion).toBeEnabled();
      await workbench.waitForTimeout(120);
      await deletion.click();
      const prompt = workbench
        .locator('.notification-list-item')
        .filter({ hasText: 'Delete 2 worktrees and their folders?' });

      await expect(prompt).toBeVisible();
      assert.ok(await stat(alpha));
      assert.ok(await stat(beta));
      await prompt.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect
        .poll(async () =>
          (await f.runGit(['worktree', 'list', '--porcelain'])).includes(alpha),
        )
        .toBe(false);
      await expect(row('alpha')).toHaveCount(0);
      await expect(row('beta')).toHaveCount(0);
      await assert.rejects(() => stat(alpha), { code: 'ENOENT' });
      await assert.rejects(() => stat(beta), { code: 'ENOENT' });
      assert.ok(
        (await f.runGit(['show-ref', '--heads'])).includes('refs/heads/alpha'),
      );
      assert.ok(
        (await f.runGit(['show-ref', '--heads'])).includes('refs/heads/beta'),
      );
      assert.match(await f.runGit(['status', '--porcelain']), /local.txt/);
    } finally {
      await vscode.commands.executeCommand('notifications.clearAll');
      await menu.update(
        'menuStyle',
        previous,
        vscode.ConfigurationTarget.Global,
      );
      if (frame)
        await frame
          .getByRole('tab', { name: 'Log', exact: true })
          .click({ timeout: 1000 })
          .catch(() => {});
      await disposeFixtureDirectory(alpha);
      await disposeFixtureDirectory(beta);
      await f.dispose();
    }
  });
});
