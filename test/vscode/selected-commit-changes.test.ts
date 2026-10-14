import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Frame, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { commandId, LOG_VIEW_ID } from '../../src/shared/extension-identity';
import {
  refreshNativeHistory,
  selectNativeRepository,
} from '../fixtures/native-panel';
import type { Fixture } from '../fixtures/repository';
import { createFixture } from '../fixtures/repository';

describe('native selected commit changes', () => {
  let fixture: Fixture;
  let frame: Frame;
  let workbench: Page;
  let id: string;
  let head: string;
  let previousMenu: string | undefined;

  beforeEach(async () => {
    fixture = await createFixture({ prefix: 'git-ui selected commit files ' });
    for (const name of ['a.txt', 'b.txt', 'c.txt'])
      await writeFile(join(fixture.root, name), `base ${name}\n`);
    await fixture.runGit(['add', '.']);
    await fixture.runGit(['commit', '-m', 'Selected file base']);
    head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    await fixture.runGit(['switch', '-c', 'source']);
    for (const name of ['a.txt', 'b.txt', 'c.txt'])
      await writeFile(join(fixture.root, name), `source ${name}\n`);
    await fixture.runGit(['add', '.']);
    await fixture.runGit(['commit', '-m', 'Selected files source']);
    await fixture.runGit(['switch', 'main']);
    const config = vscode.workspace.getConfiguration('window');

    previousMenu = config.inspect<string>('menuStyle')?.globalValue;
    await config.update(
      'menuStyle',
      'custom',
      vscode.ConfigurationTarget.Global,
    );
    id = vscode.Uri.file(fixture.root).toString();
    await (await getGitApi()).api.openRepository(vscode.Uri.file(fixture.root));
    await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
    frame = await selectNativeRepository(id);
    workbench = frame.page();
    await frame
      .getByRole('treeitem', { name: 'All branches', exact: true })
      .dblclick();
    await frame
      .locator('[data-commit-row]')
      .filter({ hasText: 'Selected files source' })
      .click();
    await expect(frame.locator('#files [data-file]')).toHaveCount(3);
  });

  afterEach(async () => {
    if (workbench) await workbench.keyboard.press('Escape');
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty && document.uri.fsPath.startsWith(fixture.root)) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand(
          'workbench.action.revertAndCloseActiveEditor',
        );
      }
    }

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand(
      'git.close',
      vscode.Uri.file(fixture.root),
    );
    await vscode.workspace
      .getConfiguration('window')
      .update('menuStyle', previousMenu, vscode.ConfigurationTarget.Global);
    await fixture.dispose();
  });

  it('the context menu applies the Shift/Cmd file selection without committing', async function () {
    this.timeout(60000);
    await writeFile(join(fixture.root, 'unrelated.txt'), 'keep staged\n');
    await fixture.runGit(['add', 'unrelated.txt']);
    await (await getGitApi()).repository(id).status();
    await refreshNativeHistory(frame, id);
    await frame
      .locator('[data-commit-row]')
      .filter({ hasText: 'Selected files source' })
      .click();
    await expect(frame.locator('#details')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const before = await fixture.runGit([
      'ls-files',
      '--stage',
      'unrelated.txt',
    ]);
    const row = (name: string) =>
      frame.getByRole('treeitem', { name: `Modified · ${name}`, exact: true });

    await row('a.txt').click();
    await row('c.txt').click({ modifiers: ['Shift'] });
    await row('b.txt').click({
      modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
    });
    await expect(
      frame.locator('#files [data-file][aria-selected="true"]'),
    ).toHaveCount(2);
    await row('c.txt').click({ button: 'right' });
    const action = workbench.locator('.monaco-menu').getByRole('menuitem', {
      name: 'Cherry-Pick Selected Changes',
      exact: true,
    });

    await expect(action).toBeVisible();
    await expect(action).toBeEnabled();
    await expect(
      workbench.getByRole('menuitem', { name: /^(Cut|Copy|Paste)\b/ }),
    ).toHaveCount(0);
    // VS Code delays its native menu mouseup listener by 100 ms.
    await action.click({ delay: 150 });
    await expect
      .poll(() => readFile(join(fixture.root, 'a.txt'), 'utf8'))
      .toBe('source a.txt\n')
      .catch(async (error: unknown) => {
        throw new Error(
          `Native application did not complete. Notifications: ${await workbench.locator('.notifications-toasts').innerText()}. Details: ${await frame.locator('#details').innerText()}`,
          { cause: error },
        );
      });
    assert.equal(
      await readFile(join(fixture.root, 'b.txt'), 'utf8'),
      'base b.txt\n',
    );
    assert.equal(
      await readFile(join(fixture.root, 'c.txt'), 'utf8'),
      'source c.txt\n',
    );
    assert.equal(
      await fixture.runGit(['ls-files', '--stage', 'unrelated.txt']),
      before,
    );
    assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
    await expect(workbench.locator('[id="workbench.view.scm"]')).toBeVisible();
  });

  it('the native Revert menu undoes the Shift/Cmd selection and preserves unchecked and staged files', async function () {
    this.timeout(60000);
    await fixture.runGit(['switch', 'source']);
    head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    await writeFile(join(fixture.root, 'unrelated.txt'), 'keep staged\n');
    await fixture.runGit(['add', 'unrelated.txt']);
    const staged = await fixture.runGit([
      'ls-files',
      '--stage',
      'unrelated.txt',
    ]);

    await (await getGitApi()).repository(id).status();
    await refreshNativeHistory(frame, id);
    await frame
      .locator('[data-commit-row]')
      .filter({ hasText: 'Selected files source' })
      .click();
    await expect(frame.locator('#details')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const row = (name: string) =>
      frame.getByRole('treeitem', { name: `Modified · ${name}`, exact: true });

    await row('a.txt').click();
    await row('c.txt').click({ modifiers: ['Shift'] });
    await row('b.txt').click({
      modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
    });
    await expect(
      frame.locator('#files [data-file][aria-selected="true"]'),
    ).toHaveCount(2);
    await row('c.txt').click({ button: 'right' });
    const revert = workbench.getByRole('menuitem', {
      name: 'Revert Selected Changes',
      exact: true,
    });

    await expect(revert).toBeEnabled();
    await expect(
      workbench.getByRole('menuitem', { name: /^(Cut|Copy|Paste)\b/ }),
    ).toHaveCount(0);
    await revert.click({ delay: 150 });
    await expect
      .poll(() => readFile(join(fixture.root, 'a.txt'), 'utf8'))
      .toBe('base a.txt\n');
    assert.equal(
      await readFile(join(fixture.root, 'b.txt'), 'utf8'),
      'source b.txt\n',
    );
    assert.equal(
      await readFile(join(fixture.root, 'c.txt'), 'utf8'),
      'base c.txt\n',
    );
    assert.equal(
      await fixture.runGit(['ls-files', '--stage', 'unrelated.txt']),
      staged,
    );
    assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
    await expect(workbench.locator('[id="workbench.view.scm"]')).toBeVisible();
  });

  it('a revert conflict remains available in native Source Control for resolution', async function () {
    this.timeout(60000);
    await fixture.runGit(['switch', 'source']);
    await writeFile(join(fixture.root, 'a.txt'), 'later a.txt\n');
    await fixture.runGit(['add', 'a.txt']);
    await fixture.runGit(['commit', '-m', 'Later edit before reverting']);
    head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    await (await getGitApi()).repository(id).status();
    await refreshNativeHistory(frame, id);
    await frame
      .locator('[data-commit-row]')
      .filter({ hasText: 'Selected files source' })
      .click();
    await expect(frame.locator('#details')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const row = frame.getByRole('treeitem', {
      name: 'Modified · a.txt',
      exact: true,
    });
    const context: unknown = JSON.parse(
      (await row.getAttribute('data-vscode-context'))!,
    );

    await vscode.commands.executeCommand(commandId('revert-files'), context);
    const repository = (await getGitApi()).repository(id);

    await repository.status();
    assert.equal(repository.state.mergeChanges.length, 1);
    assert.match(
      await readFile(join(fixture.root, 'a.txt'), 'utf8'),
      /<<<<<<< /,
    );
    assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
    assert.equal(
      await fixture
        .runGit(['rev-parse', '--verify', '--quiet', 'REVERT_HEAD'])
        .catch(() => ''),
      '',
    );
    await expect(workbench.locator('[id="workbench.view.scm"]')).toBeVisible();
  });

  it('unsaved selected editor contents stay untouched when application is refused', async function () {
    this.timeout(60000);
    const uri = vscode.Uri.file(join(fixture.root, 'a.txt'));
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();

    edit.replace(
      uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      'unsaved editor text\n',
    );
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    const row = frame.getByRole('treeitem', {
      name: 'Modified · a.txt',
      exact: true,
    });
    const context: unknown = JSON.parse(
      (await row.getAttribute('data-vscode-context'))!,
    );

    await vscode.commands.executeCommand(
      commandId('cherry-pick-files'),
      context,
    );
    await expect(workbench.locator('.notifications-toasts')).toContainText(
      'Save unsaved edits in the selected files before applying changes.',
    );
    assert.equal(document.isDirty, true);
    assert.equal(document.getText(), 'unsaved editor text\n');
    assert.equal(await readFile(uri.fsPath, 'utf8'), 'base a.txt\n');
    assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
  });

  it('native patch conflicts populate Source Control without starting a cherry-pick sequence', async function () {
    this.timeout(60000);
    await writeFile(join(fixture.root, 'a.txt'), 'target a.txt\n');
    await fixture.runGit(['add', 'a.txt']);
    await fixture.runGit(['commit', '-m', 'Target conflict']);
    head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    await (await getGitApi()).repository(id).status();
    // Reload after HEAD changes so the menu captures the current target.
    await refreshNativeHistory(frame, id);
    await frame
      .locator('[data-commit-row]')
      .filter({ hasText: 'Selected files source' })
      .click();
    await expect(frame.locator('#details')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const row = frame.getByRole('treeitem', {
      name: 'Modified · a.txt',
      exact: true,
    });

    await expect(row).toBeVisible();
    const context: unknown = JSON.parse(
      (await row.getAttribute('data-vscode-context'))!,
    );

    await vscode.commands.executeCommand(
      commandId('cherry-pick-files'),
      context,
    );
    const repository = (await getGitApi()).repository(id);

    await repository.status();
    assert.equal(
      repository.state.mergeChanges.length,
      1,
      await workbench.locator('.notifications-toasts').innerText(),
    );
    assert.equal(
      repository.state.mergeChanges[0]!.uri.fsPath,
      join(fixture.root, 'a.txt'),
    );
    assert.match(
      await readFile(join(fixture.root, 'a.txt'), 'utf8'),
      /<<<<<<< /,
    );
    assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
    assert.equal(
      await fixture
        .runGit(['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'])
        .catch(() => ''),
      '',
    );
    await expect(workbench.locator('[id="workbench.view.scm"]')).toBeVisible();
  });
});
