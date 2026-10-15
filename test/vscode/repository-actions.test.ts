import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Frame } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { sourceControlCommandId } from '../../src/shared/extension-identity';
import { captureNativeActionFailure } from '../fixtures/native-action-diagnostic';
import {
  acceptNativeQuickPick,
  activateNativeMenu,
} from '../fixtures/native-menu';
import { createFixture, type Fixture } from '../fixtures/repository';
import { sourceControlFrame } from '../fixtures/source-control-view';

async function openSelected(fixture: Fixture, other: Fixture) {
  const access = await getGitApi();

  for (const root of [other.root, fixture.root]) {
    const repository = await access.api.openRepository(vscode.Uri.file(root));

    assert.ok(repository);
    await repository.status();
  }

  await vscode.commands.executeCommand(
    sourceControlCommandId('refresh-changes'),
  );
  const frame = await sourceControlFrame();

  await frame
    .getByRole('combobox', { name: 'Repository' })
    .selectOption(vscode.Uri.file(fixture.root).toString());
  await expect(frame.getByRole('combobox', { name: 'Repository' })).toHaveValue(
    vscode.Uri.file(fixture.root).toString(),
  );
  // A native select changes its value before the host acknowledges the request.
  await expect(frame.locator('[data-source-control]')).toHaveAttribute(
    'data-vscode-context',
    JSON.stringify({
      webviewSection: 'source-control',
      preventDefaultContextMenuItems: true,
      repositoryId: vscode.Uri.file(fixture.root).toString(),
    }),
  );
  await expect(
    frame.getByRole('tab', { name: 'Commit', exact: true }),
  ).toBeEnabled();
  await expect(frame.getByText('No changes.', { exact: true })).toBeVisible();
  await vscode.commands.executeCommand('notifications.clearAll');

  return frame;
}

async function menu(frame: Frame) {
  const page = frame.page();
  const header = page
    .locator('.pane-header')
    .filter({ hasText: 'Git UI Changes' });

  await header.hover();
  const more = header.getByRole('button', { name: /More Actions/ });

  try {
    // Native title actions refresh asynchronously after repository context changes.
    // A popup opened during that refresh can close or retain its disabled snapshot.
    await expect(async () => {
      if ((await more.getAttribute('aria-expanded')) === 'true')
        await page.keyboard.press('Escape');
      await more.focus();
      await expect(more).toBeFocused();
      await expect
        .poll(() => page.evaluate(() => document.hasFocus()))
        .toBe(true);
      await more.press('Space');
      await expect(
        page.getByRole('menuitem', { name: 'Pull', exact: true }),
      ).toBeEnabled({ timeout: 500 });
    }).toPass({ timeout: 10000 });
  } catch (error) {
    await page.screenshot({
      path: join(
        process.env.GIT_UI_TEST_ARTIFACTS ?? '.artifacts',
        'repository-menu-failure.png',
      ),
    });
    throw error;
  }

  return page;
}

async function dispose(...fixtures: Fixture[]) {
  // This isolated test window owns the picker opened by its repository action.
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('notifications.clearAll');
  const access = await getGitApi();

  for (const fixture of fixtures) {
    const root = vscode.Uri.file(fixture.root);

    if (
      access.api.repositories.some(
        (repo) => repo.rootUri.toString() === root.toString(),
      )
    )
      await vscode.commands.executeCommand('git.close', root);
    await fixture.dispose();
  }
}

async function branchMenu(frame: Frame) {
  const page = await menu(frame);

  await page.getByRole('menuitem', { name: 'Branch', exact: true }).hover();
  await expect(
    page.getByRole('menuitem', { name: 'New Branch', exact: true }),
  ).toBeVisible();

  return page;
}

async function tagsMenu(frame: Frame) {
  const page = await menu(frame);

  await page.getByRole('menuitem', { name: 'Tags', exact: true }).hover();
  await expect(
    page.getByRole('menuitem', { name: 'Create Tag', exact: true }),
  ).toBeVisible();

  return page;
}

describe('Source Control repository actions', () => {
  it('opens native branch pickers from the title menu and targets the selected repository', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-quick-branch-' });
    const other = await createFixture({ prefix: 'git-ui-quick-other-' });
    let frame: Frame | undefined;

    try {
      const head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const otherHead = (await other.runGit(['rev-parse', 'HEAD'])).trim();

      frame = await openSelected(fixture, other);
      const page = await menu(frame);

      for (const name of [
        'Pull',
        'Push',
        'Checkout',
        'Fetch',
        'Branch',
        'Tags',
      ])
        await expect(
          page.getByRole('menuitem', { name, exact: true }),
        ).toBeEnabled();
      await page.getByRole('menuitem', { name: 'Branch', exact: true }).hover();
      for (const name of [
        'Merge',
        'Rebase',
        'New Branch',
        'New Branch and Checkout',
        'New Branch and Checkout From',
        'Rename',
        'Delete Branch',
        'Delete Remote Branch',
        'Publish Branch',
      ])
        await expect(
          page.getByRole('menuitem', { name, exact: true }),
        ).toBeEnabled();
      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'New Branch', exact: true }),
      );
      const widget = page.locator('.quick-input-widget:visible');
      const input = widget.locator('input').first();

      await expect(widget).toContainText(
        'Create a branch without switching to it',
      );
      await input.fill('quick-topic');
      await input.press('Enter');
      await expect
        .poll(() =>
          fixture.runGit([
            'for-each-ref',
            '--format=%(refname)',
            'refs/heads/quick-topic',
          ]),
        )
        .toBe('refs/heads/quick-topic\n');
      await expect
        .poll(() => fixture.runGit(['branch', '--show-current']))
        .toBe('main\n');
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
      assert.equal(
        (await other.runGit(['rev-parse', 'HEAD'])).trim(),
        otherHead,
      );
      assert.equal(
        await other.runGit([
          'for-each-ref',
          '--format=%(refname)',
          'refs/heads/quick-topic',
        ]),
        '',
      );
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      await branchMenu(frame);
      await activateNativeMenu(
        page.getByRole('menuitem', {
          name: 'New Branch and Checkout',
          exact: true,
        }),
      );
      await expect(widget).toContainText('Please provide a new branch name');
      await input.fill('quick-checkout');
      await input.press('Enter');
      await expect
        .poll(() => fixture.runGit(['branch', '--show-current']))
        .toBe('quick-checkout\n');
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
      assert.equal(
        (await other.runGit(['rev-parse', 'HEAD'])).trim(),
        otherHead,
      );
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      await menu(frame);
      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'Checkout', exact: true }),
      );
      // Native Checkout shows its picker before loading refs and listeners.
      // Wait for this picker and its choices before filtering the branch list.
      await expect(input).toHaveAttribute(
        'placeholder',
        'Select a branch or tag to checkout',
      );
      await expect(widget.getByText('main', { exact: true })).toBeVisible();
      await expect(input).toBeFocused();
      await input.fill('main');
      await acceptNativeQuickPick({ widget, input, label: 'main' });
      await expect
        .poll(() => fixture.runGit(['branch', '--show-current']))
        .toBe('main\n');
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      for (const [name, field, text] of [
        ['New Branch', 'prompt', 'Create a branch without switching to it'],
        [
          'New Branch and Checkout',
          'prompt',
          'Please provide a new branch name',
        ],
        [
          'New Branch and Checkout From',
          'placeholder',
          'Select a ref to create the branch from',
        ],
        ['Merge', 'placeholder', 'Select a branch or tag to merge from'],
        ['Rebase', 'placeholder', 'Select a branch to rebase onto'],
      ] as const) {
        await branchMenu(frame);
        await activateNativeMenu(
          page.getByRole('menuitem', { name, exact: true }),
        );
        try {
          await expect(widget).toBeVisible();
          if (field === 'prompt') await expect(widget).toContainText(text);
          else {
            await expect(input).toHaveAttribute('placeholder', text);
            // Native reference pickers install their cancellation listener after
            // loading items. Visibility alone can precede that readiness point.
            await expect(
              widget.getByText('quick-topic', { exact: true }),
            ).toBeVisible();
          }

          await input.focus();
          await expect(input).toBeFocused();
          await expect
            .poll(() => page.evaluate(() => document.hasFocus()))
            .toBe(true);
          await input.fill('cancelled-topic');
          await input.press('Escape');
          await expect(widget).toBeHidden();
          await expect(
            frame.getByRole('tab', { name: 'Commit', exact: true }),
          ).toBeEnabled();
        } catch (error) {
          await captureNativeActionFailure({
            frame,
            name: `repository-cancellation-${name.toLowerCase().replaceAll(' ', '-')}`,
          });
          throw error;
        }
      }

      assert.equal(
        await fixture.runGit([
          'for-each-ref',
          '--format=%(refname)',
          'refs/heads/cancelled-topic',
        ]),
        '',
      );
      await branchMenu(frame);
      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'Rename', exact: true }),
      );
      await expect(widget).toBeVisible();
      await input.fill('quick-renamed');
      await input.press('Enter');
      await expect
        .poll(() => fixture.runGit(['branch', '--show-current']))
        .toBe('quick-renamed\n');
      assert.equal(await other.runGit(['branch', '--show-current']), 'main\n');
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      await branchMenu(frame);
      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'Delete Branch', exact: true }),
      );
      await expect(input).toHaveAttribute(
        'placeholder',
        'Select a branch to delete',
      );
      await input.fill('quick-topic');
      await acceptNativeQuickPick({ widget, input, label: 'quick-topic' });
      await expect
        .poll(() =>
          fixture.runGit([
            'for-each-ref',
            '--format=%(refname)',
            'refs/heads/quick-topic',
          ]),
        )
        .toBe('');
    } catch (error) {
      if (frame)
        await captureNativeActionFailure({
          frame,
          name: 'repository-branches',
        });
      throw error;
    } finally {
      await dispose(fixture, other);
    }
  }).timeout(90000);

  it('pulls and pushes through native Git using only the selected repository and its local remote', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-quick-sync-' });
    const other = await createFixture({ prefix: 'git-ui-quick-sync-other-' });
    const remote = fixture.root + '-remote.git';

    try {
      await fixture.runGit(['init', '--bare', remote]);
      await fixture.runGit(['remote', 'add', 'origin', remote]);
      await fixture.runGit(['push', '-u', 'origin', 'main']);
      await writeFile(join(fixture.root, 'outgoing.txt'), 'outgoing\n');
      await fixture.runGit(['add', '.']);
      await fixture.runGit(['commit', '-m', 'Outgoing']);
      const outgoing = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const otherHead = (await other.runGit(['rev-parse', 'HEAD'])).trim();
      const frame = await openSelected(fixture, other);
      const page = await menu(frame);

      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'Push', exact: true }),
      );
      await expect
        .poll(async () =>
          (
            await fixture.runGit([
              '--git-dir',
              remote,
              'rev-parse',
              'refs/heads/main',
            ])
          ).trim(),
        )
        .toBe(outgoing);
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      await fixture.runGit(['switch', '-c', 'incoming']);
      await writeFile(join(fixture.root, 'incoming.txt'), 'incoming\n');
      await fixture.runGit(['add', '.']);
      await fixture.runGit(['commit', '-m', 'Incoming']);
      const incoming = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

      await fixture.runGit(['push', 'origin', 'HEAD:main']);
      await fixture.runGit(['switch', 'main']);
      // The fixture's push also updates its tracking ref. Make it stale so this
      // assertion proves Fetch refreshes it without changing the working files.
      await fixture.runGit([
        'update-ref',
        'refs/remotes/origin/main',
        outgoing,
      ]);
      await (
        await getGitApi()
      )
        .repository(vscode.Uri.file(fixture.root).toString())
        .status();
      await menu(frame);
      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'Fetch', exact: true }),
      );
      await expect
        .poll(async () =>
          (
            await fixture.runGit(['rev-parse', 'refs/remotes/origin/main'])
          ).trim(),
        )
        .toBe(incoming);
      assert.equal(
        (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
        outgoing,
      );
      await assert.rejects(
        readFile(join(fixture.root, 'incoming.txt')),
        /ENOENT/,
      );
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      await menu(frame);
      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'Pull', exact: true }),
      );
      await expect
        .poll(async () => (await fixture.runGit(['rev-parse', 'HEAD'])).trim())
        .toBe(incoming);
      assert.equal(
        await readFile(join(fixture.root, 'incoming.txt'), 'utf8'),
        'incoming\n',
      );
      assert.equal(
        (await other.runGit(['rev-parse', 'HEAD'])).trim(),
        otherHead,
      );
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
    } finally {
      await dispose(fixture, other);
      await rm(remote, { recursive: true, force: true });
    }
  }).timeout(90000);

  it('creates, pushes and deletes tags and publishes only the selected repository to its local remote', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-quick-tags-' });
    const other = await createFixture({ prefix: 'git-ui-quick-tags-other-' });
    const remote = fixture.root + '-remote.git';
    let frame: Frame | undefined;

    try {
      await fixture.runGit(['init', '--bare', remote]);
      await fixture.runGit(['remote', 'add', 'origin', remote]);
      await fixture.runGit(['push', '-u', 'origin', 'main']);
      await fixture.runGit(['push', 'origin', 'HEAD:remote-topic']);
      const head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

      frame = await openSelected(fixture, other);
      const page = await tagsMenu(frame);
      const widget = page.locator('.quick-input-widget:visible');
      const input = widget.locator('input').first();

      for (const name of [
        'Create Tag',
        'Delete Tag',
        'Delete Remote Tag',
        'Push Tags',
      ])
        await expect(
          page.getByRole('menuitem', { name, exact: true }),
        ).toBeEnabled();
      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'Create Tag', exact: true }),
      );
      await expect(input).toHaveAttribute('placeholder', 'Tag name');
      await input.fill('cancelled-tag');
      await input.press('Escape');
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      assert.equal(await fixture.runGit(['tag', '--list']), '');
      await tagsMenu(frame);
      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'Create Tag', exact: true }),
      );
      await expect(input).toHaveAttribute('placeholder', 'Tag name');
      await input.fill('quick-tag');
      await input.press('Enter');
      await expect(input).toHaveAttribute('placeholder', 'Message');
      await input.fill('Native tag message');
      await input.press('Enter');
      await expect
        .poll(() => fixture.runGit(['tag', '--list']))
        .toBe('quick-tag\n');
      assert.equal(
        (await fixture.runGit(['rev-parse', 'quick-tag^{commit}'])).trim(),
        head,
      );
      assert.equal(await other.runGit(['tag', '--list']), '');
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      await tagsMenu(frame);
      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'Push Tags', exact: true }),
      );
      await expect
        .poll(() => fixture.runGit(['--git-dir', remote, 'tag', '--list']))
        .toBe('quick-tag\n');
      // Native Push Tags then asks where to push the current branch. Complete
      // that native picker before expecting the repository action to finish.
      await expect(input).toHaveAttribute(
        'placeholder',
        'Pick a remote to publish the branch "main" to:',
      );
      await acceptNativeQuickPick({ widget, input, label: 'origin' });
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      await tagsMenu(frame);
      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'Delete Remote Tag', exact: true }),
      );
      await expect(input).toHaveAttribute(
        'placeholder',
        'Select a remote tag to delete',
      );
      // Native Git loads remote refs after showing the picker placeholder.
      await expect(widget.getByText(/quick-tag/).first()).toBeVisible();
      await expect(input).toBeVisible();
      await expect(input).toBeFocused();
      await expect
        .poll(() => page.evaluate(() => document.hasFocus()))
        .toBe(true);
      await input.fill('quick-tag');
      await acceptNativeQuickPick({ widget, input, label: /quick-tag/ });
      await expect
        .poll(() => fixture.runGit(['--git-dir', remote, 'tag', '--list']))
        .toBe('');
      assert.equal(await fixture.runGit(['tag', '--list']), 'quick-tag\n');
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      await tagsMenu(frame);
      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'Delete Tag', exact: true }),
      );
      await expect(input).toHaveAttribute(
        'placeholder',
        'Select a tag to delete',
      );
      await input.fill('quick-tag');
      await acceptNativeQuickPick({ widget, input, label: 'quick-tag' });
      await expect.poll(() => fixture.runGit(['tag', '--list'])).toBe('');
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      await branchMenu(frame);
      await activateNativeMenu(
        page.getByRole('menuitem', {
          name: 'Delete Remote Branch',
          exact: true,
        }),
      );
      await expect(input).toHaveAttribute(
        'placeholder',
        'Select a remote branch to delete',
      );
      await input.fill('origin/remote-topic');
      await acceptNativeQuickPick({
        widget,
        input,
        label: 'origin/remote-topic',
      });
      await expect
        .poll(() =>
          fixture.runGit([
            '--git-dir',
            remote,
            'for-each-ref',
            '--format=%(refname)',
            'refs/heads/remote-topic',
          ]),
        )
        .toBe('');
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      await fixture.runGit(['switch', '-c', 'publish-topic']);
      await (
        await getGitApi()
      )
        .repository(vscode.Uri.file(fixture.root).toString())
        .status();
      await branchMenu(frame);
      await activateNativeMenu(
        page.getByRole('menuitem', { name: 'Publish Branch', exact: true }),
      );
      await expect
        .poll(async () =>
          (
            await fixture.runGit([
              '--git-dir',
              remote,
              'for-each-ref',
              '--format=%(objectname)',
              'refs/heads/publish-topic',
            ])
          ).trim(),
        )
        .toBe(head);
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      assert.equal(
        await fixture.runGit(['config', 'branch.publish-topic.remote']),
        'origin\n',
      );
      assert.equal(await other.runGit(['branch', '--show-current']), 'main\n');
      assert.equal(await other.runGit(['tag', '--list']), '');
    } catch (error) {
      if (frame)
        await captureNativeActionFailure({ frame, name: 'repository-tags' });
      throw error;
    } finally {
      await dispose(fixture, other);
      await rm(remote, { recursive: true, force: true });
    }
  }).timeout(90000);
});
