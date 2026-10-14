import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../../src/extension/git/api';
import { sourceControlCommandId } from '../../../src/shared/extension-identity';
import { createFixture } from '../../fixtures/repository';
import { sourceControlFrame } from '../../fixtures/source-control-view';

export async function run(): Promise<string[]> {
  const fixture = await createFixture({ prefix: 'git-ui-rollback-' });

  try {
    await mkdir(join(fixture.root, 'src'));
    await writeFile(join(fixture.root, 'src/a.txt'), 'base\n');
    await writeFile(join(fixture.root, 'keep.txt'), 'base\n');
    await fixture.runGit(['add', '.']);
    await fixture.runGit(['commit', '-m', 'Base']);
    await writeFile(join(fixture.root, 'src/a.txt'), 'staged\n');
    await writeFile(join(fixture.root, 'keep.txt'), 'keep staged\n');
    await writeFile(join(fixture.root, 'src/new.txt'), 'keep new file\n');
    await fixture.runGit(['add', '.']);
    await writeFile(join(fixture.root, 'src/a.txt'), 'working\n');
    const access = await getGitApi();
    const repository = await access.api.openRepository(
      vscode.Uri.file(fixture.root),
    );

    assert.ok(repository);
    await repository.status();
    await vscode.commands.executeCommand(
      sourceControlCommandId('refresh-changes'),
    );
    const frame = await sourceControlFrame();
    const page = frame.page();
    const folder = frame
      .getByRole('tree', { name: 'Changes', exact: true })
      .getByRole('treeitem', { name: 'src', exact: true });
    const encoded = await folder.getAttribute('data-vscode-context');

    assert.ok(encoded);
    const context: unknown = JSON.parse(encoded);
    const cancel = vscode.commands.executeCommand(
      sourceControlCommandId('rollback-selected'),
      context,
    );

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await cancel;
    assert.equal(
      await readFile(join(fixture.root, 'src/a.txt'), 'utf8'),
      'working\n',
    );
    assert.equal(await fixture.runGit(['show', ':src/a.txt']), 'staged\n');
    const rollback = vscode.commands.executeCommand(
      sourceControlCommandId('rollback-selected'),
      context,
    );

    await page.getByRole('button', { name: 'Rollback', exact: true }).click();
    await rollback;
    assert.equal(
      await readFile(join(fixture.root, 'src/a.txt'), 'utf8'),
      'base\n',
    );
    assert.equal(await fixture.runGit(['show', ':src/a.txt']), 'base\n');
    assert.equal(await fixture.runGit(['show', ':keep.txt']), 'keep staged\n');
    assert.equal(
      await readFile(join(fixture.root, 'src/new.txt'), 'utf8'),
      'keep new file\n',
    );
    // The working folder excludes a staged-only addition. Roll it back explicitly from its own section.
    assert.equal(
      await fixture.runGit(['show', ':src/new.txt']),
      'keep new file\n',
    );
    const stagedNew = frame
      .getByRole('tree', { name: 'Staged Changes', exact: true })
      .getByRole('treeitem', { name: 'src/new.txt', exact: true });
    const stagedContext = await stagedNew.getAttribute('data-vscode-context');

    assert.ok(stagedContext);
    const unstageNew = vscode.commands.executeCommand(
      sourceControlCommandId('rollback-selected'),
      JSON.parse(stagedContext),
    );

    await page.getByRole('button', { name: 'Rollback', exact: true }).click();
    await unstageNew;
    assert.equal(await fixture.runGit(['ls-files', '--', 'src/new.txt']), '');
    const added = frame.getByRole('treeitem', {
      name: 'src/new.txt',
      exact: true,
    });

    await expect(added).toBeVisible();
    const row = await added.evaluate((node) => ({
      context: node.getAttribute('data-vscode-context'),
      snapshot: node.getAttribute('data-snapshot'),
      disabled: node.getAttribute('aria-disabled'),
    }));
    const newContext = row.context;

    assert.ok(newContext);
    const remove = vscode.commands.executeCommand(
      sourceControlCommandId('rollback-selected'),
      JSON.parse(newContext),
    );
    const outcome = { state: 'pending' };

    void Promise.resolve(remove).then(
      () => {
        outcome.state = 'completed';
      },
      (error: unknown) => {
        outcome.state = String(error);
      },
    );

    try {
      await page
        .getByRole('button', {
          name: 'Rollback and Delete New Files',
          exact: true,
        })
        .click();
      await remove;
    } catch (error) {
      const artifacts = process.env.GIT_UI_TEST_ARTIFACTS ?? '.artifacts';

      try {
        await page.screenshot({
          path: join(artifacts, 'rollback-new-file-failure.png'),
        });
        await writeFile(
          join(artifacts, 'rollback-new-file-failure.json'),
          JSON.stringify({
            row,
            outcome: outcome.state,
            dialogs: await page.locator('.monaco-dialog-box').allTextContents(),
            notifications: await page
              .locator('.notifications-toasts')
              .allTextContents(),
            changes: await frame.locator('[data-source-control]').innerText(),
            status: await fixture.runGit(['status', '--porcelain']),
          }),
        );
      } catch (diagnosticError) {
        console.warn('Could not capture rollback diagnostics', diagnosticError);
      }

      throw error;
    }

    await assert.rejects(readFile(join(fixture.root, 'src/new.txt')), {
      code: 'ENOENT',
    });
    assert.equal(await fixture.runGit(['show', ':keep.txt']), 'keep staged\n');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand(
      'git.close',
      vscode.Uri.file(fixture.root),
    );
    await fixture.dispose();
    await vscode.commands.executeCommand(
      sourceControlCommandId('refresh-changes'),
    );
  }

  return [
    'Rollback cancellation, staged and working restoration and unrelated staging preservation',
    'Rollback retains new files by default and deletes only after the explicit choice',
  ];
}
