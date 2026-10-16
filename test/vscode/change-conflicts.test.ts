import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, type Frame } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { createSourceControlBackend } from '../../src/extension/git/source-control/index';
import { sourceControlCommandId } from '../../src/shared/extension-identity';
import { captureNativeActionFailure } from '../fixtures/native-action-diagnostic';
import {
  activateNativeMenu,
  readNativeMenuContext,
} from '../fixtures/native-menu';
import { closeFixtureEditors } from '../fixtures/owned-editors';
import { createFixture, type Fixture } from '../fixtures/repository';
import { sourceControlFrame } from '../fixtures/source-control-view';

async function prepare() {
  const fixture = await createFixture({ prefix: 'git-ui-conflict-menu-' });

  try {
    await mkdir(join(fixture.root, 'src'));
    for (const path of ['src/a.txt', 'src/b.txt', 'keep.txt'])
      await writeFile(join(fixture.root, path), 'base\n');
    await fixture.runGit(['add', '.']);
    await fixture.runGit(['commit', '-m', 'Base']);
    await fixture.runGit(['checkout', '-b', 'incoming']);
    for (const path of ['src/a.txt', 'src/b.txt'])
      await writeFile(join(fixture.root, path), 'incoming\n');
    await fixture.runGit(['commit', '-am', 'Incoming']);
    await fixture.runGit(['checkout', '-b', 'current', 'HEAD~']);
    for (const path of ['src/a.txt', 'src/b.txt'])
      await writeFile(join(fixture.root, path), 'current\n');
    await fixture.runGit(['commit', '-am', 'Current']);
    await assert.rejects(fixture.runGit(['merge', 'incoming']));
    await writeFile(join(fixture.root, 'keep.txt'), 'keep staged\n');
    await fixture.runGit(['add', 'keep.txt']);
    const access = await getGitApi();
    const repository = await access.api.openRepository(
      vscode.Uri.file(fixture.root),
    );

    assert.ok(repository);
    await repository.status();
    await vscode.commands.executeCommand(
      sourceControlCommandId('refresh-changes'),
    );

    return { fixture, frame: await sourceControlFrame() };
  } catch (error) {
    try {
      await dispose(fixture);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Could not prepare or retire the conflict fixture.',
        { cause: cleanupError },
      );
    }

    throw error;
  }
}

async function dispose(fixture: Fixture) {
  try {
    await closeFixtureEditors({ roots: [fixture.root] });
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand(
      'git.close',
      vscode.Uri.file(fixture.root),
    );
  } finally {
    await fixture.dispose();
    await vscode.commands.executeCommand(
      sourceControlCommandId('refresh-changes'),
    );
  }
}

async function activateFileAction(frame: Frame, action: string) {
  const row = frame.getByRole('treeitem', { name: 'src/a.txt', exact: true });
  const page = frame.page();
  const item = page.getByRole('menuitem', { name: action, exact: true });

  // Workbench focus can settle after opening the popup and close it again.
  // Reopen only the menu; activate the mutation once after focus is ready.
  await expect(async () => {
    await page.keyboard.press('Escape');
    await row.focus();
    await expect(row).toBeFocused();
    await expect
      .poll(() => frame.evaluate(() => document.hasFocus()))
      .toBe(true);
    await row.press('Shift+F10');
    await expect(item).toBeVisible({ timeout: 500 });
    await expect(item).toBeEnabled({ timeout: 500 });
    await item.hover({ timeout: 500 });
    await item.focus({ timeout: 500 });
    await expect(item).toBeFocused({ timeout: 500 });
    await expect
      .poll(() => page.evaluate(() => document.hasFocus()), { timeout: 500 })
      .toBe(true);
  }).toPass({ timeout: 10000 });
  await activateNativeMenu(item);
}

describe('Native Changes conflict actions', () => {
  it('opens a conflicted file in its native editor and offers the merge editor', async () => {
    const { fixture, frame } = await prepare();
    const config = vscode.workspace.getConfiguration('git');
    const previous = config.inspect<boolean>('mergeEditor')?.globalValue;

    try {
      await config.update(
        'mergeEditor',
        false,
        vscode.ConfigurationTarget.Global,
      );
      const row = frame.getByRole('treeitem', {
        name: 'src/a.txt',
        exact: true,
      });

      await row.click();
      await expect
        .poll(() => {
          const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;

          return input instanceof vscode.TabInputText ? input.uri.fsPath : null;
        })
        .toBe(vscode.Uri.file(join(fixture.root, 'src/a.txt')).fsPath);
      await activateFileAction(frame, 'Resolve in Merge Editor');
      await expect(frame.page().locator('.merge-editor')).toBeVisible();
      await expect
        .poll(() =>
          vscode.window.visibleTextEditors.some(
            (editor) =>
              editor.document.uri.fsPath ===
              vscode.Uri.file(join(fixture.root, 'src/a.txt')).fsPath,
          ),
        )
        .toBe(true);
    } catch (error) {
      await captureNativeActionFailure({
        frame,
        name: 'conflict-merge-editor',
      });
      throw error;
    } finally {
      try {
        await config.update(
          'mergeEditor',
          previous,
          vscode.ConfigurationTarget.Global,
        );
      } finally {
        await dispose(fixture);
      }
    }
  }).timeout(90000);

  for (const choice of ['Current', 'Incoming'])
    it(`accepts all ${choice.toLowerCase()} changes in the selected file and stages only that resolution`, async () => {
      const { fixture, frame } = await prepare();

      try {
        await activateFileAction(frame, `Accept All ${choice}`);
        const uri = vscode.Uri.file(join(fixture.root, 'src/a.txt'));
        const document = await vscode.workspace.openTextDocument(uri);

        await expect
          .poll(() => ({ text: document.getText(), dirty: document.isDirty }))
          .toEqual({ text: `${choice.toLowerCase()}\n`, dirty: true });
        assert.ok(
          await fixture.runGit(['ls-files', '--unmerged', '--', 'src/a.txt']),
        );
        await document.save();
        // The editor edit is visible before the host finishes its operation refresh.
        await expect(
          frame.getByRole('tab', { name: 'Commit', exact: true }),
        ).toBeEnabled();
        await activateFileAction(frame, 'Stage Changes');
        await expect
          .poll(() =>
            fixture.runGit(['ls-files', '--unmerged', '--', 'src/a.txt']),
          )
          .toBe('');
        await expect(
          frame.getByRole('tab', { name: 'Commit', exact: true }),
        ).toBeEnabled();
        assert.equal(
          await fixture.runGit(['show', ':src/a.txt']),
          `${choice.toLowerCase()}\n`,
        );
        assert.ok(
          await fixture.runGit(['ls-files', '--unmerged', '--', 'src/b.txt']),
        );
        assert.equal(
          await fixture.runGit(['show', ':keep.txt']),
          'keep staged\n',
        );
        assert.match(
          await readFile(join(fixture.root, 'src/b.txt'), 'utf8'),
          /<<<<<<< /,
        );
      } catch (error) {
        await captureNativeActionFailure({
          frame,
          name: `conflict-${choice.toLowerCase()}`,
        });
        throw error;
      } finally {
        await dispose(fixture);
      }
    }).timeout(90000);
  it('keeps longer conflict markers unstaged', async () => {
    const { fixture, frame } = await prepare();

    try {
      const path = join(fixture.root, 'src/a.txt');
      const markers =
        '<'.repeat(20) +
        ' HEAD\ncurrent\n' +
        '='.repeat(20) +
        '\nincoming\n' +
        '>'.repeat(20) +
        ' incoming\n';

      await writeFile(path, markers);
      const row = frame.getByRole('treeitem', {
        name: 'src/a.txt',
        exact: true,
      });
      const context = await readNativeMenuContext(row);

      await vscode.commands.executeCommand('gitUI.stage-files', context);
      assert.ok(
        await fixture.runGit(['ls-files', '--unmerged', '--', 'src/a.txt']),
        'Unresolved custom-size conflicts must not be staged',
      );
      assert.equal(await readFile(path, 'utf8'), markers);
    } finally {
      await dispose(fixture);
    }
  });

  it('does not accept text changes through a conflicted symbolic link', async function () {
    if (process.platform === 'win32') this.skip();
    const { fixture, frame } = await prepare();
    const target = fixture.root + '.outside.txt';

    try {
      const path = join(fixture.root, 'src/a.txt');
      const content = await readFile(path, 'utf8');

      await writeFile(target, content);
      await rm(path);
      await symlink(target, path);
      const row = frame.getByRole('treeitem', {
        name: 'src/a.txt',
        exact: true,
      });
      const context = await readNativeMenuContext(row);

      await vscode.commands.executeCommand('gitUI.accept-current', context);
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path),
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        document.getText(),
        content,
        'Accept All must not edit the target of a symbolic link',
      );
      assert.equal(await readFile(target, 'utf8'), content);
    } finally {
      await dispose(fixture);
      await rm(target, { force: true });
    }
  });

  it('prepares Delete when a selected missing leaf has no parent directory', async () => {
    const { fixture } = await prepare();
    const backend = await createSourceControlBackend();

    try {
      await rm(join(fixture.root, 'src'), { recursive: true });
      const id = vscode.Uri.file(fixture.root).toString();
      const files = await backend.workingChanges(id);

      await assert.doesNotReject(
        backend.prepareFileAction({ id, files, kind: 'delete-files' }),
      );
    } finally {
      backend.dispose();
      await dispose(fixture);
    }
  });
  it('keeps encoded text conflicts unstaged and accepts their text in the native editor', async () => {
    const { fixture, frame } = await prepare();

    try {
      const path = join(fixture.root, 'src/a.txt');
      const markers = await readFile(path, 'utf8');

      await writeFile(
        path,
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(markers, 'utf16le'),
        ]),
      );
      const context = await readNativeMenuContext(
        frame.getByRole('treeitem', { name: 'src/a.txt', exact: true }),
      );

      await vscode.commands.executeCommand('gitUI.stage-files', context);
      assert.ok(
        await fixture.runGit(['ls-files', '--unmerged', '--', 'src/a.txt']),
        'UTF-16 conflict markers must not be staged',
      );
      await vscode.commands.executeCommand('gitUI.accept-current', context);
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path),
      );

      await expect.poll(() => document.getText()).toBe('current\n');
    } finally {
      await dispose(fixture);
    }
  });
});
