import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { Frame, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { sourceControlCommandId } from '../../src/shared/extension-identity';
import type { Fixture } from '../fixtures/repository';
import { createFixture } from '../fixtures/repository';
import { sourceControlFrame } from '../fixtures/source-control-view';

// Git writes spawn several processes; wait for their result before fixture cleanup.
const mutationTimeout = 30000;
const mutation = expect.configure({ timeout: mutationTimeout });

async function open(fixture: Fixture): Promise<Frame> {
  const access = await getGitApi();
  const repo = await access.api.openRepository(vscode.Uri.file(fixture.root));

  assert.ok(repo);
  await repo.status();
  await vscode.commands.executeCommand(
    sourceControlCommandId('refresh-changes'),
  );

  return sourceControlFrame();
}

async function refreshed(fixture: Fixture): Promise<void> {
  const access = await getGitApi();

  await access.repository(vscode.Uri.file(fixture.root).toString()).status();
  await vscode.commands.executeCommand(
    sourceControlCommandId('refresh-changes'),
  );
}

async function finish(
  page: Page | undefined,
  fixtures: Fixture[],
): Promise<void> {
  await page?.keyboard.press('Escape');
  for (const document of vscode.workspace.textDocuments)
    if (
      document.isDirty &&
      fixtures.some((fixture) => {
        const path = relative(fixture.root, document.uri.fsPath);

        return (
          path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
        );
      })
    ) {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand(
        'workbench.action.revertAndCloseActiveEditor',
      );
    }

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('notifications.clearAll');
  for (const fixture of fixtures) {
    await vscode.commands.executeCommand(
      'git.close',
      vscode.Uri.file(fixture.root),
    );
    await fixture.dispose();
  }

  await vscode.commands.executeCommand(
    sourceControlCommandId('refresh-changes'),
  );
}

function file(frame: Frame, path: string, section = 'Changes') {
  return frame
    .getByRole('tree', { name: section, exact: true })
    .getByRole('treeitem', { name: path, exact: true });
}

async function activate(frame: Frame, name: string): Promise<void> {
  const button = frame.getByRole('button', { name, exact: true });

  await expect(button).toBeEnabled();
  await button.click();
}

async function settled(frame: Frame): Promise<void> {
  // HEAD and refs/stash update before index reconciliation and the view refresh finish.
  await mutation(
    frame.getByRole('tab', { name: 'Commit', exact: true }),
  ).toBeEnabled();
}

describe('combined Commit and Stash view', () => {
  it('amends only the message on a clean repository and restores the draft when unchecked', async () => {
    const fixture = await createFixture({ prefix: 'git-ui amend ' });
    let frame: Frame | undefined;

    try {
      const previous = await fixture.runGit(['rev-parse', 'HEAD']);
      const tree = await fixture.runGit(['rev-parse', 'HEAD^{tree}']);
      const index = await fixture.runGit(['ls-files', '--stage', '-z']);

      frame = await open(fixture);
      await expect(
        frame
          .page()
          .getByRole('button', { name: 'Git UI Changes Section', exact: true }),
      ).toBeVisible();
      const root = frame.getByRole('treeitem', {
        name: 'Changes',
        exact: true,
      });
      const toolbar = frame.getByRole('toolbar', {
        name: 'Commit message actions',
      });
      const amend = toolbar.getByRole('checkbox', {
        name: 'Amend last commit',
      });
      const message = frame.getByRole('textbox', { name: 'Commit message' });

      await expect(root).toHaveCount(0);
      await expect(frame.getByText('No changes.')).toBeVisible();
      await message.fill('New draft');
      await expect(amend).toBeEnabled();
      await amend.press('Space');
      await mutation(message).toHaveValue('Initial');
      await expect(
        frame.getByRole('button', { name: 'Amend Commit', exact: true }),
      ).toBeEnabled();
      await amend.press('Space');
      await mutation(message).toHaveValue('New draft');
      await expect(amend).toBeEnabled();
      await amend.press('Space');
      await mutation(message).toHaveValue('Initial');
      const revised = 'Revised subject\n\nFull body\nSecond body line';

      await message.fill(revised);
      await activate(frame, 'Amend Commit');
      await mutation
        .poll(() => fixture.runGit(['show', '-s', '--format=%B', 'HEAD']))
        .toBe(`${revised}\n\n`);
      await settled(frame);
      assert.notEqual(await fixture.runGit(['rev-parse', 'HEAD']), previous);
      assert.equal(await fixture.runGit(['rev-parse', 'HEAD^{tree}']), tree);
      assert.equal(
        await fixture.runGit(['show', '-s', '--format=%P', 'HEAD']),
        '\n',
      );
      assert.equal(await fixture.runGit(['ls-files', '--stage', '-z']), index);
      await expect(amend).not.toBeChecked();
      await mutation(message).toHaveValue('');
      await frame.page().mouse.move(0, 0);
      await message.focus();
      await frame.locator('[data-source-control]').screenshot({
        path: join(
          process.env.GIT_UI_TEST_ARTIFACTS ?? fixture.root,
          'commit-message-toolbar-native.png',
        ),
      });
    } finally {
      await finish(frame?.page(), [fixture]);
    }
  }).timeout(90000);

  it('reveals the opened file without checking it and silently stashes checked files with an empty message', async () => {
    const fixture = await createFixture({ prefix: 'git-ui toolbar ' });
    let frame: Frame | undefined;

    try {
      await mkdir(join(fixture.root, 'nested', 'deeper'), { recursive: true });
      await writeFile(
        join(fixture.root, 'nested', 'deeper', 'new.txt'),
        'new file\n',
      );
      await writeFile(join(fixture.root, 'sample.txt'), 'unchecked working\n');
      const head = await fixture.runGit(['rev-parse', 'HEAD']);
      const index = await fixture.runGit(['ls-files', '--stage', '-z']);

      frame = await open(fixture);
      const message = frame.getByRole('textbox', { name: 'Commit message' });

      await message.fill('');
      const collapse = frame.getByRole('button', {
        name: 'Collapse All',
        exact: true,
      });

      // Keyboard activation keeps toolbar checks independent of macOS window activation.
      // Pointer activation is covered by the browser toolbar test.
      await collapse.press('Enter');
      await expect(file(frame, 'nested/deeper/new.txt')).toHaveCount(0);
      await vscode.window.showTextDocument(
        vscode.Uri.file(join(fixture.root, 'nested', 'deeper', 'new.txt')),
      );
      await frame
        .getByRole('button', {
          name: 'Select Opened File in Changes View',
          exact: true,
        })
        .press('Enter');
      await expect(file(frame, 'nested/deeper/new.txt')).toBeFocused();
      await expect(
        file(frame, 'nested/deeper/new.txt').getByRole('checkbox'),
      ).not.toBeChecked();
      const icon = (await file(frame, 'nested/deeper/new.txt')
        .locator('[data-file-icon]')
        .boundingBox())!;
      const name = (await file(frame, 'nested/deeper/new.txt')
        .locator(':scope > span')
        .nth(2)
        .boundingBox())!;

      assert.equal(icon.width, 16);
      assert.equal(name.x - icon.x - icon.width, 6);
      const folderCheck = (await frame
        .getByRole('treeitem', { name: 'nested/deeper', exact: true })
        .getByRole('checkbox')
        .boundingBox())!;
      const fileCheck = (await file(frame, 'nested/deeper/new.txt')
        .getByRole('checkbox')
        .boundingBox())!;

      assert.equal(fileCheck.x - folderCheck.x, 8);
      assert.equal(
        await frame
          .locator('[role="group"]')
          .first()
          .evaluate(
            (group) => getComputedStyle(group, '::before').borderLeftWidth,
          ),
        '1px',
      );
      await frame.page().bringToFront();
      await file(frame, 'nested/deeper/new.txt').focus();
      await file(frame, 'nested/deeper/new.txt')
        .getByText('new.txt', { exact: true })
        .hover();
      const tooltip = frame.getByRole('tooltip');

      await expect(tooltip).toHaveCount(1);
      await expect(tooltip).toHaveText(
        `${join(fixture.root, 'nested/deeper/new.txt')} • Untracked`,
      );
      assert.equal(
        await file(frame, 'nested/deeper/new.txt').getAttribute('title'),
        null,
      );
      await frame.locator('[data-source-control]').screenshot({
        path: join(
          process.env.GIT_UI_TEST_ARTIFACTS ?? fixture.root,
          'changes-toolbar-native.png',
        ),
      });
      await frame.page().keyboard.press('Escape');
      await expect(tooltip).toHaveCount(0);
      await file(frame, 'nested/deeper/new.txt').getByRole('checkbox').click();
      await activate(frame, 'Stash Silently');
      await mutation
        .poll(async () =>
          (await fixture.runGit(['stash', 'list', '--format=%gs'])).trim(),
        )
        .toBe('Changes');
      await settled(frame);
      await expect(file(frame, 'nested/deeper/new.txt')).toHaveCount(0);
      assert.equal(await fixture.runGit(['rev-parse', 'HEAD']), head);
      assert.equal(await fixture.runGit(['ls-files', '--stage', '-z']), index);
      assert.equal(
        await readFile(join(fixture.root, 'sample.txt'), 'utf8'),
        'unchecked working\n',
      );
      await expect(message).toHaveValue('');
    } finally {
      await finish(frame?.page(), [fixture]);
    }
  }).timeout(60000);

  (process.platform === 'win32' ? it.skip : it)(
    'previews the link text that will be committed for live and dangling symlinks',
    async () => {
      const fixture = await createFixture({ prefix: 'git-ui link preview ' });
      let frame: Frame | undefined;

      try {
        await symlink('sample.txt', join(fixture.root, 'tracked-link'));
        await fixture.runGit(['add', 'tracked-link']);
        await fixture.runGit(['commit', '-m', 'Link base']);
        await unlink(join(fixture.root, 'tracked-link'));
        await symlink('missing-target', join(fixture.root, 'tracked-link'));
        await symlink('sample.txt', join(fixture.root, 'new-link'));
        frame = await open(fixture);
        for (const [path, content] of [
          ['tracked-link', 'missing-target'],
          ['new-link', 'sample.txt'],
        ] as const) {
          // Exercise the installed click handler; browser tests cover pointer routing.
          await file(frame, path).evaluate((node) => {
            if (!(node instanceof HTMLElement))
              throw new Error('Expected a changed-file row.');
            node.click();
          });
          await expect
            .poll(async () => {
              const input =
                vscode.window.tabGroups.activeTabGroup.activeTab?.input;

              return input instanceof vscode.TabInputTextDiff
                ? (
                    await vscode.workspace.openTextDocument(input.modified)
                  ).getText()
                : null;
            })
            .toBe(content);
          await file(frame, path).getByRole('checkbox').click();
        }

        await frame
          .getByRole('textbox', { name: 'Commit message' })
          .fill('Commit link targets');
        await activate(frame, 'Commit');
        await mutation
          .poll(async () =>
            (await fixture.runGit(['log', '-1', '--format=%s'])).trim(),
          )
          .toBe('Commit link targets');
        await settled(frame);
        assert.equal(
          await fixture.runGit(['show', 'HEAD:tracked-link']),
          'missing-target',
        );
        assert.equal(
          await fixture.runGit(['show', 'HEAD:new-link']),
          'sample.txt',
        );
      } catch (error) {
        if (frame) {
          await frame.page().screenshot({
            path: join(
              process.env.GIT_UI_TEST_ARTIFACTS ?? fixture.root,
              'combined-link-failure.png',
            ),
          });
        }

        throw error;
      } finally {
        await finish(frame?.page(), [fixture]);
      }
    },
  ).timeout(60000);

  it('commits checked folders from an inline message and restores one saved file in native diffs', async () => {
    const fixture = await createFixture({ prefix: 'git-ui combined ' });
    let frame: Frame | undefined;

    try {
      await mkdir(join(fixture.root, 'chosen', 'nested'), { recursive: true });
      await writeFile(join(fixture.root, 'chosen', 'same.txt'), 'base one\n');
      await writeFile(
        join(fixture.root, 'chosen', 'nested', 'same.txt'),
        'base two\n',
      );
      await fixture.runGit(['add', '.']);
      await fixture.runGit(['commit', '-m', 'Folder base']);
      await writeFile(join(fixture.root, 'chosen', 'same.txt'), 'commit one\n');
      await writeFile(
        join(fixture.root, 'chosen', 'nested', 'same.txt'),
        'commit two\n',
      );
      await writeFile(join(fixture.root, 'sample.txt'), 'unchecked staged\n');
      await fixture.runGit(['add', 'sample.txt']);
      const originalIndex = await fixture.runGit(['show', ':sample.txt']);

      await writeFile(join(fixture.root, 'sample.txt'), 'unchecked working\n');
      await writeFile(join(fixture.root, 'new.txt'), 'new file\n');
      frame = await open(fixture);
      await expect(file(frame, 'chosen/nested/same.txt')).toBeVisible();
      await expect(file(frame, 'chosen')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await file(frame, 'chosen').getByRole('checkbox').click();
      await expect(
        file(frame, 'chosen/same.txt').getByRole('checkbox'),
      ).toBeChecked();
      assert.equal(
        await fixture.runGit(['diff', '--cached', '--name-only']),
        'sample.txt\n',
      );
      await file(frame, 'chosen/same.txt').click();
      await expect
        .poll(() => {
          const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;

          return input instanceof vscode.TabInputTextDiff
            ? input.modified.fsPath
            : '';
        })
        .toBe(vscode.Uri.file(join(fixture.root, 'chosen', 'same.txt')).fsPath);
      const message = frame.getByRole('textbox', { name: 'Commit message' });

      await message.fill('Commit checked folders\n\nKeep unchecked staging.');
      await frame.getByRole('tab', { name: 'Stashes', exact: true }).click();
      await frame.getByRole('tab', { name: 'Commit', exact: true }).click();
      await expect(message).toHaveValue(
        'Commit checked folders\n\nKeep unchecked staging.',
      );
      await activate(frame, 'Commit');
      await mutation
        .poll(async () =>
          (await fixture.runGit(['log', '-1', '--format=%s'])).trim(),
        )
        .toBe('Commit checked folders');
      await settled(frame);
      assert.deepEqual(
        (
          await fixture.runGit([
            'diff-tree',
            '--no-commit-id',
            '--name-only',
            '-r',
            'HEAD',
          ])
        )
          .trim()
          .split('\n')
          .sort(),
        ['chosen/nested/same.txt', 'chosen/same.txt'],
      );
      assert.equal(
        await fixture.runGit(['show', ':sample.txt']),
        originalIndex,
      );
      assert.equal(
        await readFile(join(fixture.root, 'sample.txt'), 'utf8'),
        'unchecked working\n',
      );
      await expect(message).toHaveValue('');

      await writeFile(join(fixture.root, 'chosen', 'same.txt'), 'saved one\n');
      await writeFile(
        join(fixture.root, 'chosen', 'nested', 'same.txt'),
        'saved two\n',
      );
      await refreshed(fixture);
      await file(frame, 'chosen').getByRole('checkbox').click();
      await message.fill('Keep my next commit draft');
      await frame
        .getByRole('button', { name: 'Stash Silently', exact: true })
        .click();
      // Windows can temporarily lock the file while Git restores its contents.
      await mutation(async () => {
        expect(
          await readFile(join(fixture.root, 'chosen', 'same.txt'), 'utf8'),
        ).toBe('commit one\n');
      }).toPass({ timeout: mutationTimeout });
      await settled(frame);
      const stashSha = (
        await fixture.runGit(['rev-parse', 'refs/stash'])
      ).trim();

      await frame.getByRole('tab', { name: 'Stashes', exact: true }).click();
      const stash = frame.locator(`[data-stash="${stashSha}"]`);

      await expect(stash).toBeVisible();
      await stash.getByRole('button', { name: /Changes/ }).click();
      const saved = file(frame, 'chosen/same.txt', 'Saved files');

      await expect(saved).toBeVisible();
      await frame
        .getByRole('button', { name: 'Collapse All', exact: true })
        .click();
      await expect(saved).toHaveCount(0);
      await frame
        .getByRole('button', { name: 'Expand All', exact: true })
        .click();
      await expect(saved).toBeVisible();
      await saved.click();
      await expect
        .poll(() => {
          const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;

          return (
            input instanceof vscode.TabInputTextDiff &&
            input.modified.query.includes(stashSha)
          );
        })
        .toBe(true);
      await saved.getByRole('checkbox').click();
      await frame.locator('[data-source-control]').screenshot({
        path: join(
          process.env.GIT_UI_TEST_ARTIFACTS ?? fixture.root,
          'stash-toolbar-native.png',
        ),
      });
      await frame
        .getByRole('button', { name: 'Apply Stash', exact: true })
        .click();
      await mutation(async () => {
        expect(
          await readFile(join(fixture.root, 'chosen', 'same.txt'), 'utf8'),
        ).toBe('saved one\n');
      }).toPass({ timeout: mutationTimeout });
      await settled(frame);
      assert.equal(
        await readFile(
          join(fixture.root, 'chosen', 'nested', 'same.txt'),
          'utf8',
        ),
        'commit two\n',
      );
      assert.equal(
        (await fixture.runGit(['rev-parse', 'refs/stash'])).trim(),
        stashSha,
      );
      assert.equal(
        await fixture.runGit(['show', ':sample.txt']),
        originalIndex,
      );
      await stash
        .getByRole('button', { name: /Changes/ })
        .click({ button: 'right' });
      const deletion = frame
        .page()
        .getByRole('menuitem', { name: /Delete Stash/ });

      await expect(deletion).toBeEnabled();
      // VS Code delays custom-menu mouseup handlers by 100ms to ignore the opener.
      await frame.page().waitForTimeout(120);
      await deletion.click({ timeout: 5000 });
      await frame
        .page()
        .getByRole('button', { name: 'Delete Stash', exact: true })
        .click({ timeout: 5000 });
      await mutation(stash).toHaveCount(0);
      await settled(frame);
      assert.equal(await fixture.runGit(['stash', 'list']), '');
      assert.equal(
        await readFile(join(fixture.root, 'chosen', 'same.txt'), 'utf8'),
        'saved one\n',
      );
    } catch (error) {
      if (frame) {
        await writeFile(
          join(
            process.env.GIT_UI_TEST_ARTIFACTS ?? fixture.root,
            'combined-stashes-failure.html',
          ),
          await frame.content(),
        );
        await frame.page().screenshot({
          path: join(
            process.env.GIT_UI_TEST_ARTIFACTS ?? fixture.root,
            'combined-stashes-failure.png',
          ),
        });
      }

      throw error;
    } finally {
      await finish(frame?.page(), [fixture]);
    }
  }).timeout(120000);

  it('retains the inline draft and selection when saving is cancelled or a Git operation blocks committing', async () => {
    const fixture = await createFixture({ prefix: 'git-ui combined guards ' });
    let frame: Frame | undefined;
    const uri = vscode.Uri.file(join(fixture.root, 'sample.txt'));

    try {
      await writeFile(uri.fsPath, 'selected on disk\n');
      frame = await open(fixture);
      await file(frame, 'sample.txt').getByRole('checkbox').click();
      const message = frame.getByRole('textbox', { name: 'Commit message' });

      await message.fill('Keep this draft');
      const head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const index = await fixture.runGit(['show', ':sample.txt']);
      const document = await vscode.workspace.openTextDocument(uri);

      await vscode.window.showTextDocument(document);
      const edit = new vscode.WorkspaceEdit();

      edit.insert(uri, new vscode.Position(0, 0), 'unsaved buffer\n');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await activate(frame, 'Commit');
      await frame
        .page()
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
      await expect(
        frame.getByRole('button', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
      assert.equal(await fixture.runGit(['show', ':sample.txt']), index);
      assert.equal(document.isDirty, true);
      await expect(message).toHaveValue('Keep this draft');
      await expect(
        file(frame, 'sample.txt').getByRole('checkbox'),
      ).toBeChecked();
      await vscode.commands.executeCommand(
        'workbench.action.revertAndCloseActiveEditor',
      );
      await writeFile(join(fixture.root, '.git', 'MERGE_HEAD'), head + '\n');
      await activate(frame, 'Commit');
      await expect(frame.getByRole('alert')).toHaveCount(0);
      await expect(
        frame
          .page()
          .locator('.notification-list-item')
          .filter({ hasText: /merge|operation/i }),
      ).toBeVisible();
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
      assert.equal(await fixture.runGit(['show', ':sample.txt']), index);
      await expect(message).toHaveValue('Keep this draft');
      await expect(
        file(frame, 'sample.txt').getByRole('checkbox'),
      ).toBeChecked();
      await unlink(join(fixture.root, '.git', 'MERGE_HEAD'));
    } finally {
      await finish(frame?.page(), [fixture]);
    }
  });

  it('uses the chosen repository and retains checks and message in another repository', async () => {
    const first = await createFixture({ prefix: 'git-ui first target ' });
    const second = await createFixture({ prefix: 'git-ui second target ' });
    let frame: Frame | undefined;

    try {
      await writeFile(join(first.root, 'sample.txt'), 'first changes\n');
      await writeFile(join(second.root, 'sample.txt'), 'second changes\n');
      frame = await open(first);
      await open(second);
      const picker = frame.getByRole('combobox', { name: 'Repository' });

      await picker.selectOption(vscode.Uri.file(second.root).toString());
      await file(frame, 'sample.txt').getByRole('checkbox').click();
      await frame
        .getByRole('textbox', { name: 'Commit message' })
        .fill('Second draft');
      const secondHead = (await second.runGit(['rev-parse', 'HEAD'])).trim();

      await picker.selectOption(vscode.Uri.file(first.root).toString());
      await file(frame, 'sample.txt').getByRole('checkbox').click();
      await frame
        .getByRole('textbox', { name: 'Commit message' })
        .fill('Commit first repository');
      await activate(frame, 'Commit');
      await mutation
        .poll(async () =>
          (await first.runGit(['log', '-1', '--format=%s'])).trim(),
        )
        .toBe('Commit first repository');
      await settled(frame);
      assert.equal(
        (await second.runGit(['rev-parse', 'HEAD'])).trim(),
        secondHead,
      );
      assert.equal(await second.runGit(['show', ':sample.txt']), 'first\n');
      assert.equal(
        await readFile(join(second.root, 'sample.txt'), 'utf8'),
        'second changes\n',
      );
      await picker.selectOption(vscode.Uri.file(second.root).toString());
      await expect(
        frame.getByRole('textbox', { name: 'Commit message' }),
      ).toHaveValue('Second draft');
      await expect(
        file(frame, 'sample.txt').getByRole('checkbox'),
      ).toBeChecked();
    } catch (error) {
      if (frame)
        await writeFile(
          join(
            process.env.GIT_UI_TEST_ARTIFACTS ?? '.artifacts',
            'multi-repository-failure.json',
          ),
          JSON.stringify(
            {
              body: await frame.page().locator('body').innerText(),
              view: await frame.content(),
              repositories: (await getGitApi()).repositories(),
              head: await first.runGit(['log', '-1', '--format=%s']),
            },
            null,
            2,
          ),
        );
      throw error;
    } finally {
      await finish(frame?.page(), [first, second]);
    }
  }).timeout(60000);
});
