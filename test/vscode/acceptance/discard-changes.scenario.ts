import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../../src/extension/git/api';
import { sourceControlCommandId } from '../../../src/shared/extension-identity';
import { createFixture, type Fixture } from '../../fixtures/repository';
import { sourceControlFrame } from '../../fixtures/source-control-view';

async function open(fixture: Fixture) {
  const access = await getGitApi();
  const repo = await access.api.openRepository(vscode.Uri.file(fixture.root));

  assert.ok(repo);
  await repo.status();
  await vscode.commands.executeCommand(
    sourceControlCommandId('refresh-changes'),
  );
  const frame = await sourceControlFrame();

  return { repo, frame, page: frame.page() };
}

async function close(fixture: Fixture) {
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

async function discardStagedWorkingCopy() {
  const fixture = await createFixture({ prefix: 'git-ui-discard-' });
  let context: Awaited<ReturnType<typeof open>> | undefined;

  try {
    const path = join(fixture.root, 'sample.txt');

    await writeFile(path, 'staged\n');
    await fixture.runGit(['add', 'sample.txt']);
    await writeFile(path, 'working\n');
    await writeFile(join(fixture.root, 'other.txt'), 'keep\n');
    const index = await fixture.runGit(['ls-files', '--stage', '-z']);

    context = await open(fixture);
    const { frame, page } = context;
    const row = frame.getByRole('treeitem', {
      name: 'sample.txt',
      exact: true,
    });
    const discard = row.getByRole('button', {
      name: 'Discard Changes',
      exact: true,
    });

    await row.focus();
    await discard.press('Enter');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await row.focus();
    await expect(discard).toBeEnabled();
    assert.equal(await readFile(path, 'utf8'), 'working\n');
    assert.equal(await fixture.runGit(['ls-files', '--stage', '-z']), index);
    await row.focus();
    await discard.press('Enter');
    await page
      .getByRole('button', { name: 'Discard File', exact: true })
      .click();
    await expect(
      frame.getByRole('button', { name: 'Refresh', exact: true }),
    ).toBeEnabled();
    await expect(
      row.getByRole('button', {
        name: 'Discard Changes',
        exact: true,
        includeHidden: true,
      }),
    ).toHaveCount(0);
    assert.equal(await readFile(path, 'utf8'), 'staged\n');
    assert.equal(await fixture.runGit(['ls-files', '--stage', '-z']), index);
    assert.equal(
      await readFile(join(fixture.root, 'other.txt'), 'utf8'),
      'keep\n',
    );
    await expect(row.getByRole('checkbox')).not.toBeChecked();
    const encoded = await row.getAttribute('data-vscode-context');

    assert.ok(encoded);
    await vscode.commands.executeCommand(
      sourceControlCommandId('open-working-file'),
      JSON.parse(encoded),
    );
    assert.equal(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      vscode.Uri.file(path).fsPath,
    );
    assert.equal(
      vscode.window.activeTextEditor?.document.getText(),
      'staged\n',
    );
  } catch (error) {
    if (context) {
      await writeFile(
        join(
          process.env.GIT_UI_TEST_ARTIFACTS ?? fixture.root,
          'discard-failure.json',
        ),
        JSON.stringify({
          notifications: await context.page
            .locator('.notification-list-item')
            .allTextContents(),
          gitStatus: await fixture.runGit(['status', '--porcelain=v1']),
          index: await fixture.runGit(['show', ':sample.txt']),
          contents: await readFile(join(fixture.root, 'sample.txt'), 'utf8'),
          rootUri: context.repo.rootUri.toString(),
          changes: await context.frame
            .locator('[data-source-control]')
            .innerText(),
        }),
      );
    }

    throw error;
  } finally {
    await close(fixture);
  }
}

async function discardDeletedAndUntracked() {
  const fixture = await createFixture({ prefix: 'git-ui-discard-files-' });
  const setting = vscode.workspace.getConfiguration('git');
  const previous = setting.inspect<boolean>(
    'discardUntrackedChangesToTrash',
  )?.globalValue;

  try {
    await setting.update(
      'discardUntrackedChangesToTrash',
      false,
      vscode.ConfigurationTarget.Global,
    );
    await unlink(join(fixture.root, 'sample.txt'));
    await writeFile(join(fixture.root, 'new.txt'), 'remove\n');
    await writeFile(join(fixture.root, 'keep.txt'), 'keep\n');
    const { frame, page } = await open(fixture);
    const removed = frame.getByRole('treeitem', {
      name: 'sample.txt',
      exact: true,
    });

    await removed.focus();
    await removed
      .getByRole('button', { name: 'Discard Changes', exact: true })
      .press('Enter');
    await page
      .getByRole('button', { name: 'Restore File', exact: true })
      .click();
    await expect(removed).toHaveCount(0);
    assert.equal(
      await readFile(join(fixture.root, 'sample.txt'), 'utf8'),
      'first\n',
    );
    const added = frame.getByRole('treeitem', {
      name: 'new.txt',
      exact: true,
    });

    await added.focus();
    await added
      .getByRole('button', { name: 'Discard Changes', exact: true })
      .press('Enter');
    await page
      .getByRole('button', { name: 'Delete File', exact: true })
      .click();
    await expect(added).toHaveCount(0);
    await assert.rejects(readFile(join(fixture.root, 'new.txt')), {
      code: 'ENOENT',
    });
    assert.equal(
      await readFile(join(fixture.root, 'keep.txt'), 'utf8'),
      'keep\n',
    );
  } finally {
    await setting.update(
      'discardUntrackedChangesToTrash',
      previous,
      vscode.ConfigurationTarget.Global,
    );
    await close(fixture);
  }
}

export async function run(): Promise<string[]> {
  await discardStagedWorkingCopy();
  await discardDeletedAndUntracked();

  return [
    'Discard cancellation and staged-working copy preservation',
    'Deleted file restoration and selective untracked file deletion',
  ];
}
