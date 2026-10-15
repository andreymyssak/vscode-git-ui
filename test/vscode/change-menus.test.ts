import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Frame } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { sourceControlCommandId } from '../../src/shared/extension-identity';
import { createFixture, type Fixture } from '../fixtures/repository';
import { sourceControlFrame } from '../fixtures/source-control-view';

async function prepare(inWorkspace = false) {
  const workspace = vscode.workspace.workspaceFolders?.[0];

  if (inWorkspace) assert.ok(workspace);
  const fixture = await createFixture({
    prefix: 'git-ui-change-menu-',
    ...(inWorkspace && workspace ? { directory: workspace.uri.fsPath } : {}),
  });

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
  'Copy Relative Path': 'copy-relative-path',
  Delete: 'delete-files',
  'Reveal in Explorer View': 'reveal-in-explorer',
  Commit: 'commit-selected',
  Stash: 'stash-selected',
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
    // Cancel both modal confirmations and quick inputs before joining their commands.
    await frame.page().screenshot({
      path: join(
        process.env.GIT_UI_TEST_ARTIFACTS ?? '.artifacts',
        'change-action-failure.png',
      ),
    });
    await frame.page().keyboard.press('Escape');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await Promise.allSettled(operations);
    throw error;
  }
}

describe('Changes context actions', () => {
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
      await row(frame, 'keep.txt').press('Shift+F10');
      await expect(
        frame.page().getByRole('menuitem', { name: 'Delete', exact: true }),
      ).toBeVisible();
      await expect(
        frame.page().getByRole('menuitem', {
          name: 'Reveal in Explorer View',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        frame.page().getByRole('menuitem', {
          name: 'Commit',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        frame.page().getByRole('menuitem', {
          name: 'Stash',
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

  it('reveals a clicked file within a selection and its folder in the native Explorer', async () => {
    const { fixture, frame } = await prepare(true);

    try {
      await row(frame, 'src/a.txt').click({ modifiers: ['ControlOrMeta'] });
      await row(frame, 'src/b.txt').click({ modifiers: ['Shift'] });
      await runContextAction(frame, 'src/a.txt', 'Reveal in Explorer View');
      await expect(
        frame
          .page()
          .getByRole('tree', { name: 'Files Explorer' })
          .locator('.monaco-list-row.focused'),
      ).toContainText('a.txt');
      const reopened = await sourceControlFrame();

      await runContextAction(reopened, 'src', 'Reveal in Explorer View');
      await expect(
        frame.page().getByRole('tree', { name: 'Files Explorer' }),
      ).toBeVisible();
      await expect(
        frame
          .page()
          .getByRole('tree', { name: 'Files Explorer' })
          .locator('.monaco-list-row.focused'),
      ).toContainText('src');
    } finally {
      await frame.page().keyboard.press('Escape');
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
        runContextAction(frame, 'src', 'Stash', async () => {
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

  // Commit, stash and selected-file restore each run real Git and native UI.
  // Allow Windows process startup across the full workflow.
  it('commits and stashes the highlighted files while preserving a different checked and staged file', async () => {
    const { fixture, frame } = await prepare();

    try {
      const keepIndex = await fixture.runGit(['show', ':keep.txt']);

      await row(frame, 'keep.txt').getByRole('checkbox').click();
      await expect(row(frame, 'keep.txt').getByRole('checkbox')).toBeChecked();
      await frame
        .getByRole('textbox', { name: 'Commit message' })
        .fill('Commit selected files');
      await runContextAction(frame, 'src', 'Commit');
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
      await runContextAction(frame, 'src', 'Stash', async () => {
        const name = frame.page().locator('.quick-input-widget input');

        await expect(name).toBeVisible();
        await name.fill('Stash selected files');
        await name.press('Enter');
      });
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
  }).timeout(60000);
});
