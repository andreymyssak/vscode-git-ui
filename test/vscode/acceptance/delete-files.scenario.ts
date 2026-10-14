import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../../src/extension/git/api';
import { sourceControlCommandId } from '../../../src/shared/extension-identity';
import { createFixture } from '../../fixtures/repository';
import { sourceControlFrame } from '../../fixtures/source-control-view';

export async function run(): Promise<string[]> {
  const fixture = await createFixture({ prefix: 'git-ui-delete-files-' });

  try {
    await mkdir(join(fixture.root, 'src/gone'), { recursive: true });
    for (const path of ['src/a.txt', 'src/gone/b.txt', 'keep.txt'])
      await writeFile(join(fixture.root, path), 'base\n');
    await fixture.runGit(['add', '.']);
    await fixture.runGit(['commit', '-m', 'Base']);
    await writeFile(join(fixture.root, 'src/a.txt'), 'working\n');
    await writeFile(join(fixture.root, 'src/new.txt'), 'new\n');
    await rm(join(fixture.root, 'src/gone'), { recursive: true });
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
    const frame = await sourceControlFrame();
    const page = frame.page();
    const folder = frame.getByRole('treeitem', { name: 'src', exact: true });
    const encoded = await folder.getAttribute('data-vscode-context');

    assert.ok(encoded);
    const context: unknown = JSON.parse(encoded);
    const before = await fixture.runGit(['status', '--porcelain']);
    const index = await fixture.runGit(['ls-files', '--stage', '-z']);
    const cancel = vscode.commands.executeCommand(
      sourceControlCommandId('delete-files'),
      context,
    );

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await cancel;
    assert.equal(await fixture.runGit(['status', '--porcelain']), before);
    const changed = vscode.commands.executeCommand(
      sourceControlCommandId('delete-files'),
      context,
    );
    const confirm = page.getByRole('button', {
      name: /Move to (Trash|Recycle Bin)/,
    });

    await expect(confirm).toBeVisible();
    await writeFile(
      join(fixture.root, 'src/a.txt'),
      'changed during confirmation\n',
    );
    await confirm.click();
    await changed;
    assert.equal(
      await readFile(join(fixture.root, 'src/a.txt'), 'utf8'),
      'changed during confirmation\n',
    );
    assert.equal(
      await readFile(join(fixture.root, 'src/new.txt'), 'utf8'),
      'new\n',
    );
    await vscode.commands.executeCommand('notifications.clearAll');
    const remove = vscode.commands.executeCommand(
      sourceControlCommandId('delete-files'),
      context,
    );

    await page
      .getByRole('button', { name: /Move to (Trash|Recycle Bin)/ })
      .click();
    await remove;
    for (const path of ['src/a.txt', 'src/new.txt'])
      await assert.rejects(readFile(join(fixture.root, path)), {
        code: 'ENOENT',
      });
    assert.equal(await fixture.runGit(['ls-files', '--stage', '-z']), index);
    assert.equal(
      await readFile(join(fixture.root, 'keep.txt'), 'utf8'),
      'keep staged\n',
    );
    await expect(
      frame.getByRole('treeitem', { name: 'src/a.txt', exact: true }),
    ).toHaveAttribute('data-status', 'deleted');
  } finally {
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

  return [
    'Delete confirms Trash disposal, skips missing leaves, rejects stale contents, and preserves staging',
  ];
}
