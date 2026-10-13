import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Frame } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { sourceControlCommandId } from '../../src/shared/extension-identity';
import { createFixture, type Fixture } from '../fixtures/repository';
import { sourceControlFrame } from '../fixtures/source-control-view';

async function prepare() {
  const fixture = await createFixture({ prefix: 'git-ui-change-menu-' });

  try {
    await mkdir(join(fixture.root, 'src'));
    for (const path of ['src/a.txt', 'src/b.txt', 'keep.txt'])
      await writeFile(join(fixture.root, path), 'base\n');
    await fixture.runGit(['add', '.']);
    await fixture.runGit(['commit', '-m', 'Add sample files']);
    for (const path of ['src/a.txt', 'src/b.txt', 'keep.txt'])
      await writeFile(join(fixture.root, path), 'changed\n');
    await fixture.runGit(['add', 'keep.txt']);
    const access = await getGitApi();
    const repo = await access.api.openRepository(vscode.Uri.file(fixture.root));

    assert.ok(repo);
    await repo.status();
    await vscode.commands.executeCommand(
      sourceControlCommandId('refresh-changes'),
    );
    const frame = await sourceControlFrame();

    return { fixture, frame };
  } catch (error) {
    await dispose(fixture);
    throw error;
  }
}

async function dispose(fixture: Fixture) {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand(
    'git.close',
    vscode.Uri.file(fixture.root),
  );
  await fixture.dispose();
  await vscode.commands.executeCommand(
    sourceControlCommandId('refresh-changes'),
  );
}

const row = (frame: Frame, path: string) =>
  frame.getByRole('treeitem', { name: path, exact: true });

const contextActions = {
  'Open File': 'open-working-file',
  'Copy Relative Path': 'copy-relative-path',
  'Show Changes': 'open-working-change',
  'Commit Selected Files…': 'commit-selected',
  'Stash Selected Files…': 'stash-selected',
  'Apply Selected Files': 'apply-stash-files',
} as const;

async function runContextAction(
  frame: Frame,
  path: string,
  action: keyof typeof contextActions,
  interact?: () => Promise<void>,
) {
  const target = row(frame, path);

  await target.focus();
  await expect
    .poll(() =>
      target.evaluate(
        (element) => document.hasFocus() && document.activeElement === element,
      ),
    )
    .toBe(true);
  await target.press('Shift+F10');
  const menuItem = frame
    .page()
    .getByRole('menuitem', { name: action, exact: true });

  await expect
    .poll(async () =>
      menuItem
        .evaluate((element) => ({
          visible: element.getBoundingClientRect().height > 0,
          enabled: element.getAttribute('aria-disabled') !== 'true',
        }))
        .catch(() => null),
    )
    .toEqual({ visible: true, enabled: true })
    .catch(async (error: unknown) => {
      await writeFile(
        join(
          process.env.GIT_UI_TEST_ARTIFACTS ?? '.artifacts',
          'change-menu-diagnostic.json',
        ),
        JSON.stringify({
          path,
          action,
          bounds: await target.boundingBox(),
          menus: await frame.page().getByRole('menuitem').allTextContents(),
          context: await target.getAttribute('data-vscode-context'),
          focus: await frame.evaluate(() => ({
            focused: document.hasFocus(),
            active: document.activeElement?.outerHTML.slice(0, 500),
            menuVisible: document.body.classList.contains(
              'vscode-context-menu-visible',
            ),
          })),
          text: await frame.page().locator('body').innerText(),
        }),
      );
      await frame.page().screenshot({
        path: join(
          process.env.GIT_UI_TEST_ARTIFACTS ?? '.artifacts',
          'change-menu-failure.png',
        ),
      });
      throw error;
    });
  const encoded = await target.getAttribute('data-vscode-context');

  assert.ok(encoded);
  await frame.page().keyboard.press('Escape');
  await expect(frame.page().getByRole('menu')).toHaveCount(0);
  // Exercise menu dismissal returning focus to the editor rather than the tree.
  await vscode.commands.executeCommand(
    'workbench.action.focusActiveEditorGroup',
  );
  // Finish menu dismissal before restoring focus through the nested webview.
  await expect
    .poll(() =>
      frame.evaluate(() =>
        document.body.classList.contains('vscode-context-menu-visible'),
      ),
    )
    .toBe(false);
  await target.focus();
  await expect
    .poll(() =>
      target.evaluate(
        (element) => document.hasFocus() && document.activeElement === element,
      ),
    )
    .toBe(true);
  // Check rendering and invoke the contributed command with that exact context.
  // VS Code's temporary custom-menu mouseup guard is unrelated to command routing.
  const operations = [
    Promise.resolve().then(() =>
      vscode.commands.executeCommand(
        sourceControlCommandId(contextActions[action]),
        JSON.parse(encoded),
      ),
    ),
    Promise.resolve().then(() => interact?.()),
  ];

  try {
    await Promise.all(operations);
  } catch (error) {
    // Cancel the native prompt before joining a command waiting for its answer.
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await Promise.allSettled(operations);
    throw error;
  }
}

describe('Changes context actions', () => {
  it('opens existing selected working files when another file in their folder was deleted', async () => {
    const { fixture, frame } = await prepare();

    try {
      await rm(join(fixture.root, 'src/a.txt'));
      await vscode.commands.executeCommand(
        sourceControlCommandId('refresh-changes'),
      );
      await expect(row(frame, 'src/a.txt')).toHaveAttribute(
        'data-status',
        'deleted',
      );
      await runContextAction(frame, 'src', 'Open File');
      const uri = vscode.Uri.file(join(fixture.root, 'src/b.txt')).toString();

      await expect
        .poll(() =>
          vscode.window.tabGroups.all
            .flatMap((group) => group.tabs)
            .some(
              (tab) =>
                tab.input instanceof vscode.TabInputText &&
                tab.input.uri.toString() === uri,
            ),
        )
        .toBe(true);
    } finally {
      await frame.page().keyboard.press('Escape');
      await dispose(fixture);
    }
  });
  it('copies the highlighted range and folder path through native menus without changing inclusion', async () => {
    const { fixture, frame } = await prepare();
    const clipboard = await vscode.env.clipboard.readText();

    try {
      await row(frame, 'keep.txt').getByRole('checkbox').click();
      await expect(row(frame, 'keep.txt').getByRole('checkbox')).toBeChecked();
      // Select the range without opening a diff that could steal menu focus.
      await row(frame, 'src/a.txt').click({ modifiers: ['ControlOrMeta'] });
      await row(frame, 'src/b.txt').click({ modifiers: ['Shift'] });
      await runContextAction(frame, 'src/a.txt', 'Copy Relative Path');
      await expect
        .poll(
          async () =>
            (await vscode.env.clipboard.readText()) === 'src/a.txt\nsrc/b.txt',
        )
        .toBe(true);
      await expect(
        row(frame, 'src/a.txt').getByRole('checkbox'),
      ).not.toBeChecked();
      await expect(
        row(frame, 'src/b.txt').getByRole('checkbox'),
      ).not.toBeChecked();
      await expect(row(frame, 'keep.txt').getByRole('checkbox')).toBeChecked();
      await runContextAction(frame, 'src', 'Copy Relative Path');
      await expect
        .poll(async () => (await vscode.env.clipboard.readText()) === 'src')
        .toBe(true);
      await runContextAction(frame, 'Changes', 'Show Changes');
      await expect
        .poll(
          () =>
            vscode.window.tabGroups.all
              .flatMap((group) => group.tabs)
              .filter((tab) => tab.input instanceof vscode.TabInputTextDiff)
              .length,
        )
        .toBe(3);
      await row(frame, 'keep.txt').press('Shift+F10');
      await expect(
        frame
          .page()
          .getByRole('menuitem', { name: 'Show Staged Changes', exact: true }),
      ).toBeVisible();
      await expect(
        frame.page().getByRole('menuitem', {
          name: 'Commit Selected Files…',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        frame.page().getByRole('menuitem', {
          name: 'Stash Selected Files…',
          exact: true,
        }),
      ).toBeVisible();
      await frame.page().keyboard.press('Escape');
    } finally {
      await frame.page().keyboard.press('Escape');
      await vscode.env.clipboard.writeText(clipboard);
      await dispose(fixture);
    }
  });

  it('cancels the stash prompt before cleanup when prompt interaction fails', async () => {
    const { fixture, frame } = await prepare();
    const failure = new Error('Prompt interaction failed');
    const name = frame.page().locator('.quick-input-widget input');

    try {
      const status = await fixture.runGit(['status', '--porcelain']);
      const keepIndex = await fixture.runGit(['show', ':keep.txt']);

      await assert.rejects(
        runContextAction(frame, 'src', 'Stash Selected Files…', async () => {
          await expect(name).toBeVisible();
          throw failure;
        }),
        (error: unknown) => error === failure,
      );
      await expect(name).not.toBeVisible();
      assert.equal(await fixture.runGit(['status', '--porcelain']), status);
      assert.equal(await fixture.runGit(['show', ':keep.txt']), keepIndex);
      assert.equal(await fixture.runGit(['stash', 'list']), '');
    } finally {
      await frame.page().keyboard.press('Escape');
      await dispose(fixture);
    }
  });

  it('commits and stashes the highlighted files while preserving a different checked and staged file', async () => {
    const { fixture, frame } = await prepare();

    try {
      const keepIndex = await fixture.runGit(['show', ':keep.txt']);

      await row(frame, 'keep.txt').getByRole('checkbox').click();
      await expect(row(frame, 'keep.txt').getByRole('checkbox')).toBeChecked();
      await frame
        .getByRole('textbox', { name: 'Commit message' })
        .fill('Commit selected files');
      await runContextAction(frame, 'src', 'Commit Selected Files…');
      await expect
        .poll(() => fixture.runGit(['log', '-1', '--format=%s']))
        .toBe('Commit selected files\n');
      assert.equal(
        await fixture.runGit([
          'diff-tree',
          '--no-commit-id',
          '--name-only',
          '-r',
          'HEAD',
        ]),
        'src/a.txt\nsrc/b.txt\n',
      );
      assert.equal(await fixture.runGit(['show', ':keep.txt']), keepIndex);
      await expect(row(frame, 'keep.txt').getByRole('checkbox')).toBeChecked();
      for (const path of ['src/a.txt', 'src/b.txt'])
        await writeFile(join(fixture.root, path), 'stash these changes\n');
      await vscode.commands.executeCommand(
        sourceControlCommandId('refresh-changes'),
      );
      await frame
        .getByRole('textbox', { name: 'Commit message' })
        .fill('Keep this commit draft');
      await runContextAction(
        frame,
        'src',
        'Stash Selected Files…',
        async () => {
          const name = frame.page().locator('.quick-input-widget input');

          await expect(name).toBeVisible();
          await name.fill('Stash selected files');
          await name.press('Enter');
        },
      );
      await expect(
        frame.getByRole('textbox', { name: 'Commit message' }),
      ).toHaveValue('Keep this commit draft');
      await expect
        .poll(() => fixture.runGit(['stash', 'list', '--format=%s']))
        .toContain('Stash selected files');
      assert.equal(
        await readFile(join(fixture.root, 'src/a.txt'), 'utf8'),
        'changed\n',
      );
      assert.equal(
        await readFile(join(fixture.root, 'keep.txt'), 'utf8'),
        'changed\n',
      );
      assert.equal(await fixture.runGit(['show', ':keep.txt']), keepIndex);
      await frame.getByRole('tab', { name: 'Stashes', exact: true }).click();
      const stash = frame.locator('[data-stash]').first();

      await stash.getByRole('button', { name: /Stash selected files/ }).click();
      await row(frame, 'src/a.txt').click({ modifiers: ['ControlOrMeta'] });
      await runContextAction(frame, 'src/a.txt', 'Apply Selected Files');
      await expect
        .poll(() => readFile(join(fixture.root, 'src/a.txt'), 'utf8'))
        .toBe('stash these changes\n');
      assert.equal(
        await readFile(join(fixture.root, 'src/b.txt'), 'utf8'),
        'changed\n',
      );
      assert.ok(await fixture.runGit(['stash', 'list']));
    } finally {
      await frame.page().keyboard.press('Escape');
      await dispose(fixture);
    }
  });
});
