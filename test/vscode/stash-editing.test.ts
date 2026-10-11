import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { sourceControlCommandId } from '../../src/shared/extension-identity';
import { nativeBrowser } from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';
import { sourceControlFrame } from '../fixtures/source-control-view';

it('silently stashes as Changes without using or clearing the commit draft, then renames and deletes saved files through native menus', async () => {
  const fixture = await createFixture({ prefix: 'git-ui stash editing ' });

  try {
    await writeFile(join(fixture.root, 'sample.txt'), 'saved tracked\n');
    await writeFile(join(fixture.root, 'new.txt'), 'saved new\n');
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
    const message = frame.getByRole('textbox', { name: 'Commit message' });
    const draft =
      'Commit subject\n\nA long commit body belongs to the commit editor.';

    await message.fill(draft);
    await frame
      .getByRole('treeitem', { name: 'Changes', exact: true })
      .getByRole('checkbox')
      .press('Space');
    await expect(
      frame
        .getByRole('treeitem', { name: 'sample.txt', exact: true })
        .getByRole('checkbox'),
    ).toBeChecked();
    await expect(
      frame
        .getByRole('treeitem', { name: 'new.txt', exact: true })
        .getByRole('checkbox'),
    ).toBeChecked();
    await frame
      .getByRole('button', { name: 'Stash Silently', exact: true })
      .press('Enter');
    await expect(message).toHaveValue(draft);
    await expect(frame.getByText('No changes.', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await frame.getByRole('tab', { name: 'Stashes', exact: true }).click();
    const stash = frame.getByRole('region', { name: 'Changes', exact: true });

    await expect(stash).toBeVisible();
    await stash
      .getByRole('button', { name: 'Expand Changes', exact: true })
      .click();
    await expect(
      stash.getByRole('treeitem', { name: 'sample.txt', exact: true }),
    ).toBeVisible();
    await stash
      .getByRole('treeitem', { name: 'new.txt', exact: true })
      .getByRole('checkbox')
      .check();
    const page = frame.page();

    await stash
      .getByRole('button', { name: 'Collapse Changes', exact: true })
      .click({ button: 'right' });
    await expect(
      page.getByRole('menuitem', { name: /Rename Stash/ }),
    ).toBeVisible();
    const stashContext = await stash.getAttribute('data-vscode-context');

    assert.ok(stashContext);
    await page.keyboard.press('Escape');
    // Invoke the rendered command with its actual context, outside VS Code's mouseup guard.
    const renaming = vscode.commands.executeCommand(
      sourceControlCommandId('rename-stash'),
      JSON.parse(stashContext),
    );
    const name = page.locator('.quick-input-widget input');

    await expect(name).toBeVisible();
    await name.fill('My saved changes');
    await name.press('Enter');
    await renaming;
    await expect(name).toBeHidden();
    const renamed = frame.getByRole('region', {
      name: 'My saved changes',
      exact: true,
    });

    await expect(renamed).toBeVisible({ timeout: 30000 });
    await expect(
      renamed.getByRole('button', {
        name: 'Collapse My saved changes',
        exact: true,
      }),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(
      renamed
        .getByRole('treeitem', { name: 'new.txt', exact: true })
        .getByRole('checkbox'),
    ).toBeChecked();
    const file = renamed.getByRole('treeitem', {
      name: 'sample.txt',
      exact: true,
    });

    await expect(file).toBeVisible();
    await expect(file.getByRole('checkbox')).toBeEnabled();
    await file.focus();
    await expect(file).toBeFocused();
    // Open the native menu from the focused row after quick input closes.
    await file.press('Shift+F10');
    await expect(
      page.getByRole('menuitem', { name: /Apply Selected Files/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: /Delete Selected Files/ }),
    ).toBeVisible();
    const fileContext = await file.getAttribute('data-vscode-context');

    assert.ok(fileContext);
    await page.keyboard.press('Escape');
    const deleting = vscode.commands.executeCommand(
      sourceControlCommandId('delete-stash-files'),
      JSON.parse(fileContext),
    );

    await page
      .getByRole('button', { name: 'Delete Saved Files', exact: true })
      .click();
    await deleting;
    const retained = frame.getByRole('region', {
      name: 'My saved changes',
      exact: true,
    });

    await expect(retained).toBeVisible({ timeout: 30000 });
    await expect(
      retained.getByRole('button', {
        name: 'Collapse My saved changes',
        exact: true,
      }),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(
      retained.getByRole('treeitem', { name: 'sample.txt', exact: true }),
    ).toHaveCount(0);
    await expect(
      retained.getByRole('treeitem', { name: 'new.txt', exact: true }),
    ).toBeVisible();
    assert.equal(await fixture.runGit(['show', 'HEAD:sample.txt']), 'first\n');
    assert.equal((await fixture.runGit(['status', '--porcelain'])).trim(), '');
  } catch (error) {
    const browser = await nativeBrowser();
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) =>
        candidate.url().includes('/workbench/workbench.html'),
      );

    await page?.screenshot({
      path: join(
        process.env.GIT_UI_TEST_ARTIFACTS ?? fixture.root,
        'stash-editing-failure.png',
      ),
    });
    console.info(await page?.locator('body').innerText());
    throw error;
  } finally {
    await vscode.commands.executeCommand(
      'git.close',
      vscode.Uri.file(fixture.root),
    );
    await fixture.dispose();
    await vscode.commands.executeCommand(
      sourceControlCommandId('refresh-changes'),
    );
  }
}).timeout(90000);
