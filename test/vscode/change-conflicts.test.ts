import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { createSourceControlBackend } from '../../src/extension/git/source-control/index';
import { sourceControlCommandId } from '../../src/shared/extension-identity';
import { createFixture, type Fixture } from '../fixtures/repository';
import { sourceControlFrame } from '../fixtures/source-control-view';

async function prepare() {
  const fixture = await createFixture({ prefix: 'git-ui-conflict-menu-' });

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
}

async function dispose(fixture: Fixture) {
  for (const document of vscode.workspace.textDocuments)
    if (document.uri.fsPath.startsWith(fixture.root) && document.isDirty)
      await document.save();
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
      await row.focus();
      await row.press('Shift+F10');
      const item = frame.page().getByRole('menuitem', {
        name: 'Resolve in Merge Editor',
        exact: true,
      });

      await expect(item).toBeVisible();
      await item.click({ delay: 150 });
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
    } finally {
      await config.update(
        'mergeEditor',
        previous,
        vscode.ConfigurationTarget.Global,
      );
      await dispose(fixture);
    }
  });

  for (const choice of ['Current', 'Incoming'])
    it(`accepts all ${choice.toLowerCase()} changes in the selected file and stages only that resolution`, async () => {
      const { fixture, frame } = await prepare();

      try {
        const row = frame.getByRole('treeitem', {
          name: 'src/a.txt',
          exact: true,
        });

        await row.focus();
        await row.press('Shift+F10');
        const item = frame
          .page()
          .getByRole('menuitem', { name: `Accept All ${choice}`, exact: true });

        await expect(item).toBeVisible();
        await item.click({ delay: 150 });
        const uri = vscode.Uri.file(join(fixture.root, 'src/a.txt'));
        const document = await vscode.workspace.openTextDocument(uri);

        await expect
          .poll(() => document.getText())
          .toBe(`${choice.toLowerCase()}\n`);
        assert.ok(document.isDirty);
        assert.ok(
          await fixture.runGit(['ls-files', '--unmerged', '--', 'src/a.txt']),
        );
        await document.save();
        // The editor edit is visible before the host finishes its operation refresh.
        await expect(
          frame.getByRole('tab', { name: 'Commit', exact: true }),
        ).toBeEnabled();
        await row.focus();
        await row.press('Shift+F10');
        await frame
          .page()
          .getByRole('menuitem', { name: 'Stage Changes', exact: true })
          .click({ delay: 150 });
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
      } finally {
        await dispose(fixture);
      }
    });
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
      const encoded = await row.getAttribute('data-vscode-context');

      assert.ok(encoded);
      await vscode.commands.executeCommand(
        'gitUI.stage-files',
        JSON.parse(encoded),
      );
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
      const encoded = await row.getAttribute('data-vscode-context');

      assert.ok(encoded);
      await vscode.commands.executeCommand(
        'gitUI.accept-current',
        JSON.parse(encoded),
      );
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
      const encoded = await frame
        .getByRole('treeitem', { name: 'src/a.txt', exact: true })
        .getAttribute('data-vscode-context');

      assert.ok(encoded);
      await vscode.commands.executeCommand(
        'gitUI.stage-files',
        JSON.parse(encoded),
      );
      assert.ok(
        await fixture.runGit(['ls-files', '--unmerged', '--', 'src/a.txt']),
        'UTF-16 conflict markers must not be staged',
      );
      await vscode.commands.executeCommand(
        'gitUI.accept-current',
        JSON.parse(encoded),
      );
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path),
      );

      await expect.poll(() => document.getText()).toBe('current\n');
    } finally {
      await dispose(fixture);
    }
  });
});
