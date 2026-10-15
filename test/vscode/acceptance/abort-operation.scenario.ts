import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Frame } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../../src/extension/git/api';
import {
  commandId,
  LOG_VIEW_ID,
  sourceControlCommandId,
} from '../../../src/shared/extension-identity';
import { captureNativeActionFailure } from '../../fixtures/native-action-diagnostic';
import { activateNativeButton } from '../../fixtures/native-menu';
import { selectNativeRepository } from '../../fixtures/native-panel';
import { createFixture } from '../../fixtures/repository';
import { sourceControlFrame } from '../../fixtures/source-control-view';

export async function run(): Promise<string[]> {
  const passed: string[] = [];
  const completion = expect.configure({
    timeout: process.platform === 'win32' ? 15000 : 5000,
  });

  for (const kind of [
    'selected-revert',
    'selected-cherry',
    'merge',
    'rebase',
    'cherry-pick',
    'revert',
    'legacy',
  ] as const) {
    const f = await createFixture({ prefix: 'git-ui-abort-' });
    const selected = kind.startsWith('selected') || kind === 'legacy';
    let activeFrame: Frame | undefined;

    try {
      const base = (await f.runGit(['rev-parse', 'HEAD'])).trim();

      await f.runGit(['switch', '-c', 'source']);
      await writeFile(join(f.root, 'sample.txt'), 'source\n');
      await writeFile(join(f.root, 'added.txt'), 'added\n');
      await f.runGit(['add', '.']);
      await f.runGit(['commit', '-m', 'Changes to cancel']);
      const source = (await f.runGit(['rev-parse', 'HEAD'])).trim();

      await f.runGit(['switch', 'main']);
      if (kind === 'selected-revert' || kind === 'revert')
        await f.runGit(['cherry-pick', source]);
      await writeFile(join(f.root, 'sample.txt'), 'target\n');
      await f.runGit(['add', 'sample.txt']);
      await f.runGit(['commit', '-m', 'Target']);
      const head = (await f.runGit(['rev-parse', 'HEAD'])).trim();

      if (selected) {
        await writeFile(join(f.root, 'keep.txt'), 'staged\n');
        await f.runGit(['add', 'keep.txt']);
        await writeFile(join(f.root, 'keep.txt'), 'working\n');
      }

      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(f.root),
      );

      assert.ok(repository);
      const id = repository.rootUri.toString();

      if (selected) {
        await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
        const log = await selectNativeRepository(id);

        await log
          .getByRole('treeitem', { name: 'All branches', exact: true })
          .dblclick();
        await log
          .locator('[data-commit-row]')
          .filter({ hasText: 'Changes to cancel' })
          .click();
        await expect(log.locator('#files [data-file]')).toHaveCount(2);
        const rows = log.locator('#files [data-file]');

        await rows.first().click();
        await rows.last().click({ modifiers: ['Shift'] });
        const context = await rows.last().getAttribute('data-vscode-context');

        assert.ok(context);
        await vscode.commands.executeCommand(
          commandId(
            kind === 'selected-revert' ? 'revert-files' : 'cherry-pick-files',
          ),
          JSON.parse(context),
        );
        if (kind === 'legacy')
          await unlink(
            (
              await f.runGit([
                'rev-parse',
                '--path-format=absolute',
                '--git-path',
                'git-ui-selected-changes.json',
              ])
            ).trim(),
          );
      } else {
        await assert.rejects(
          f.runGit([
            kind,
            kind === 'merge' || kind === 'rebase' ? 'source' : source,
          ]),
        );
      }

      await repository.status();
      await vscode.commands.executeCommand(
        sourceControlCommandId('refresh-changes'),
      );
      await vscode.commands.executeCommand('notifications.clearAll');
      const frame = await sourceControlFrame();

      activeFrame = frame;
      const page = frame.page();
      const label =
        kind === 'selected-revert'
          ? 'Abort Selected Revert'
          : kind === 'selected-cherry'
            ? 'Abort Selected Cherry-Pick'
            : kind === 'legacy'
              ? 'Discard Conflicts…'
              : `Abort ${kind === 'cherry-pick' ? 'Cherry-Pick' : kind.charAt(0).toUpperCase() + kind.slice(1)}`;
      const button = frame.getByRole('button', { name: label, exact: true });

      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute(
        'aria-description',
        /restore|Restore|return/,
      );
      const before = await f.runGit(['status', '--porcelain']);

      if (kind === 'selected-revert') {
        await activateNativeButton(button);
        await activateNativeButton(
          page.getByRole('button', { name: 'Cancel', exact: true }),
        );
        await expect(
          frame.getByRole('tab', { name: 'Commit', exact: true }),
        ).toBeEnabled();
        assert.equal(await f.runGit(['status', '--porcelain']), before);
        await activateNativeButton(button);
        const confirm = page.getByRole('button', { name: label, exact: true });

        await expect(confirm).toBeVisible();
        await writeFile(
          join(f.root, 'sample.txt'),
          'edited during confirmation\n',
        );
        await activateNativeButton(confirm);
        await completion(page.locator('.notifications-toasts')).toContainText(
          'changed while confirming',
        );
        await expect(
          frame.getByRole('tab', { name: 'Commit', exact: true }),
        ).toBeEnabled();
        assert.equal(
          await readFile(join(f.root, 'sample.txt'), 'utf8'),
          'edited during confirmation\n',
        );
        await vscode.commands.executeCommand('notifications.clearAll');
      }

      await activateNativeButton(button);
      const confirmation = page.getByRole('button', {
        name: label.replace('…', ''),
        exact: true,
      });

      await activateNativeButton(confirmation);
      await completion(button).toHaveCount(0);
      assert.equal(await f.runGit(['ls-files', '-u']), '');
      assert.equal((await f.runGit(['rev-parse', 'HEAD'])).trim(), head);
      assert.equal(
        (await f.runGit(['symbolic-ref', 'HEAD'])).trim(),
        'refs/heads/main',
      );
      assert.equal(
        await readFile(join(f.root, 'sample.txt'), 'utf8'),
        'target\n',
      );
      if (selected) {
        assert.equal(await f.runGit(['show', ':keep.txt']), 'staged\n');
        assert.equal(
          await readFile(join(f.root, 'keep.txt'), 'utf8'),
          'working\n',
        );
        if (kind === 'selected-revert' || kind === 'legacy')
          assert.equal(
            await readFile(join(f.root, 'added.txt'), 'utf8'),
            'added\n',
          );
        else
          await assert.rejects(readFile(join(f.root, 'added.txt')), {
            code: 'ENOENT',
          });
      } else assert.equal(await f.runGit(['status', '--porcelain']), '');
      assert.notEqual(base, head);
      passed.push(
        `${label} uses its own confirmation and cancels the matching operation`,
      );
    } catch (error) {
      if (activeFrame)
        await captureNativeActionFailure({
          frame: activeFrame,
          name: `abort-${kind}`,
        });
      throw error;
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('notifications.clearAll');
      await vscode.commands.executeCommand(
        'git.close',
        vscode.Uri.file(f.root),
      );
      await f.dispose();
      await vscode.commands.executeCommand(
        sourceControlCommandId('refresh-changes'),
      );
    }
  }

  return passed;
}
