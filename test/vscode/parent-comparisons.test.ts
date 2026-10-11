import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { LOG_VIEW_ID } from '../../src/shared/extension-identity';
import {
  refreshNativeHistory,
  selectNativeRepository,
} from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';

describe('native parent comparisons', () => {
  it('loads collapsed counts, opens the exact parent diff, and explains a valid empty parent', async () => {
    const fixture = await createFixture({
      prefix: 'git-ui-native parent comparisons ',
    });
    const rootUri = vscode.Uri.file(fixture.root);

    try {
      await writeFile(
        join(fixture.root, 'docs.txt'),
        'Baseline documentation\n',
      );
      await fixture.runGit(['add', 'docs.txt']);
      await fixture.runGit(['commit', '-m', 'Baseline documentation']);
      const base = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const commit = async (message: string, parents: string[]) => {
        const tree = (await fixture.runGit(['write-tree'])).trim();

        return (
          await fixture.runGit([
            'commit-tree',
            tree,
            ...parents.flatMap((parent) => ['-p', parent]),
            '-m',
            message,
          ])
        ).trim();
      };

      await writeFile(join(fixture.root, 'api.txt'), 'API\n');
      await fixture.runGit(['add', '.']);
      const api = await commit('API changes', [base]);

      await fixture.runGit(['reset', '--hard', base]);
      await writeFile(join(fixture.root, 'ui.txt'), 'UI\n');
      await fixture.runGit(['add', '.']);
      const ui = await commit('UI changes', [base]);

      await writeFile(join(fixture.root, 'api.txt'), 'API\n');
      await fixture.runGit(['add', '.']);
      const merge = await commit('Real two-parent comparison', [api, ui]);

      await fixture.runGit(['reset', '--hard', base]);
      await writeFile(join(fixture.root, 'docs.txt'), 'Docs\n');
      await fixture.runGit(['add', '.']);
      const docs = await commit('Documentation changes', [base]);

      await writeFile(join(fixture.root, 'api.txt'), 'API\n');
      await writeFile(join(fixture.root, 'ui.txt'), 'UI\n');
      await fixture.runGit(['add', '.']);
      const octopus = await commit('Real three-parent comparison', [
        base,
        merge,
        docs,
      ]);

      await fixture.runGit(['reset', '--hard', api]);
      const empty = await commit('Valid empty second parent', [base, api]);

      await fixture.runGit(['update-ref', 'refs/heads/empty-example', empty]);
      await fixture.runGit(['reset', '--hard', octopus]);
      const access = await getGitApi();

      await access.api.openRepository(rootUri);
      await access.repository(rootUri.toString()).status();
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      const frame = await selectNativeRepository(rootUri.toString());

      await frame.page().bringToFront();
      // Another native test can leave a focused search draft in this shared panel.
      const search = frame.getByRole('searchbox', { name: 'Text or hash' });

      await search.fill('');
      await search.press('Enter');
      const row = await refreshNativeHistory(frame, rootUri.toString());

      await expect(row).toHaveAttribute('data-sha', octopus);

      await row.evaluate((node) => (node as HTMLElement).click());
      const first = frame.locator(`[data-parent="${base}"]`);
      const second = frame.locator(`[data-parent="${merge}"]`);
      const third = frame.locator(`[data-parent="${docs}"]`);

      await expect(first.locator('summary').first()).toContainText('3 files');
      await expect(second.locator('summary').first()).toContainText('1 file');
      await expect(third.locator('summary').first()).toContainText('2 files');
      await expect(second.locator('summary').first()).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await second
        .locator('summary')
        .first()
        .evaluate((node) => (node as HTMLElement).click());
      const file = second.getByRole('treeitem', {
        name: 'Modified · docs.txt',
      });

      await expect(file).toBeVisible();
      await file.evaluate((node) =>
        node.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        ),
      );
      await expect
        .poll(() => {
          const tab = vscode.window.tabGroups.all
            .flatMap((group) => group.tabs)
            .find(
              (tab) =>
                tab.isActive && tab.input instanceof vscode.TabInputTextDiff,
            );
          const input = tab?.input as vscode.TabInputTextDiff | undefined;

          return input?.original.scheme === 'git' &&
            input.modified.scheme === 'git'
            ? {
                original: JSON.parse(input.original.query).ref as string,
                modified: JSON.parse(input.modified.query).ref as string,
                path: input.modified.fsPath,
              }
            : null;
        })
        .toEqual({
          original: merge,
          modified: octopus,
          path: vscode.Uri.joinPath(rootUri, 'docs.txt').fsPath,
        });

      await frame
        .getByRole('treeitem', { name: 'All branches', exact: true })
        .evaluate((node) =>
          node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
        );
      // History can retain visible rows while restoring the prior selection.
      const emptyRow = frame.locator(
        `#history-pane[aria-busy="false"] [data-commit-row][data-sha="${empty}"]`,
      );

      await expect(emptyRow).toBeVisible();
      await emptyRow.evaluate((node) => (node as HTMLElement).click());
      await expect(emptyRow).toHaveAttribute('aria-selected', 'true');
      const emptyGroup = frame.locator(`[data-parent="${api}"]`);

      await expect(emptyGroup.locator('summary').first()).toContainText(
        '0 files',
      );
      await expect(emptyGroup.locator('summary').first()).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await emptyGroup
        .locator('summary')
        .first()
        .evaluate((node) => (node as HTMLElement).click());
      await expect(
        emptyGroup.getByText('No changes compared with this parent.'),
      ).toBeVisible();
      await expect(emptyGroup.locator('[data-file]')).toHaveCount(0);
      assert.equal(
        (await fixture.runGit(['status', '--porcelain'])).trim(),
        '',
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fixture.dispose();
    }
  });
});
