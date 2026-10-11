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
    const folder = frame.getByRole('treeitem', { name: 'src', exact: true });
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
    assert.equal(await fixture.runGit(['ls-files', '--', 'src/new.txt']), '');
    const added = frame.getByRole('treeitem', {
      name: 'src/new.txt',
      exact: true,
    });

    await expect(added).toBeVisible();
    const newContext = await added.getAttribute('data-vscode-context');

    assert.ok(newContext);
    const remove = vscode.commands.executeCommand(
      sourceControlCommandId('rollback-selected'),
      JSON.parse(newContext),
    );

    await page
      .getByRole('button', {
        name: 'Rollback and Delete New Files',
        exact: true,
      })
      .click();
    await remove;
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
