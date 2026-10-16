import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, type Frame } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { LOG_VIEW_ID } from '../../src/shared/extension-identity';
import { isRecord } from '../../src/shared/validation';
import {
  refreshNativeHistory,
  selectNativeRepository,
} from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';

describe('native header controls', () => {
  it('reveals current history, presents commit references and applies both filters', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-native header ' });
    const rootUri = vscode.Uri.file(fixture.root);
    let frame: Frame | undefined;
    let stage = 'open fixture';

    try {
      const target = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

      await fixture.runGit(['branch', 'nav-target', target]);
      await fixture.runGit(['tag', 'v-header', target]);
      await fixture.runGit(['commit', '--allow-empty', '-m', 'Next']);
      const head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const access = await getGitApi();

      await access.api.openRepository(rootUri);
      await access.repository(rootUri.toString()).status();
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      frame = await selectNativeRepository(rootUri.toString());
      await frame.page().bringToFront();
      const search = frame.getByRole('searchbox', { name: 'Text or hash' });

      stage = 'reset search';
      await search.fill('', { timeout: 5000 });
      await search.press('Enter', { timeout: 5000 });
      const row = await refreshNativeHistory(frame, rootUri.toString());

      stage = 'wait for fixture history';
      await expect(row).toHaveAttribute('data-sha', head);
      const generation = async () => {
        const context: unknown = JSON.parse(
          (await row.getAttribute('data-vscode-context')) ?? '{}',
        );

        assert.ok(isRecord(context));
        assert.equal(context.repositoryId, rootUri.toString());
        assert.ok(typeof context.generation === 'number');

        return context.generation;
      };

      const previousGeneration = await generation();

      stage = 'physically refresh current history';
      await expect(frame.locator('[data-reference-tooltip]')).toHaveCount(0);
      await frame
        .getByRole('button', { name: 'Refresh', exact: true })
        .click({ timeout: 5000 });
      await expect.poll(generation).toBeGreaterThan(previousGeneration);
      const branchSearch = frame.getByRole('searchbox', {
        name: 'Branch or tag',
      });

      for (const selector of [
        '#branch-search .codicon-search',
        '#search-controls .codicon-search',
      ])
        await expect(frame.locator(selector)).toHaveCSS('font-size', '14px');
      await frame
        .getByRole('button', { name: 'Hide Git Branches' })
        .click({ timeout: 5000 });
      await expect(branchSearch).toBeHidden();
      await expect(row).toHaveAttribute('data-sha', head);
      stage = 'reopen from empty rail area';
      const show = frame.getByRole('button', { name: 'Show Git Branches' });
      const rail = (await frame.locator('#branch-pane').boundingBox())!;

      await show.click({
        position: { x: rail.width / 2, y: rail.height - 12 },
        timeout: 5000,
      });
      await expect(branchSearch).toBeVisible();
      stage = 'select user';
      await frame
        .getByRole('button', { name: 'User filter', exact: true })
        .click({ timeout: 5000 });
      await frame
        .getByRole('button', { name: 'Me', exact: true })
        .click({ timeout: 5000 });
      await expect(
        frame.getByRole('button', { name: 'User filter', exact: true }),
      ).toHaveText('Me');
      await frame
        .getByRole('button', { name: 'Clear user filter' })
        .click({ timeout: 5000 });
      stage = 'search native authors by email';
      await vscode.commands.executeCommand('notifications.hideToasts');
      await frame
        .getByRole('button', { name: 'User filter', exact: true })
        .click({ timeout: 5000 });
      await frame
        .getByRole('button', { name: 'Select users…' })
        .click({ timeout: 5000 });
      const workbench = frame.page();
      const authorSearch = workbench.getByPlaceholder('Search name or email');
      const choices = workbench.locator('.quick-input-list .monaco-list-row');

      await authorSearch.fill('fixture@example.test', { timeout: 5000 });
      await expect(choices).toHaveCount(1);
      await expect(choices).toContainText('Fixture');
      await choices.getByRole('checkbox').click({ timeout: 5000 });
      await workbench.screenshot({
        path: '.artifacts/author-picker-native.png',
      });
      await authorSearch.press('Enter', { timeout: 5000 });
      await expect(
        frame.getByRole('button', { name: 'User filter', exact: true }),
      ).toHaveText('Fixture');
      await frame
        .getByRole('button', { name: 'User filter', exact: true })
        .getByText('Fixture', { exact: true })
        .click({ timeout: 5000 });
      await frame
        .getByRole('button', { name: 'Select users…' })
        .click({ timeout: 5000 });
      await expect(choices.getByRole('checkbox')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await authorSearch.press('Escape', { timeout: 5000 });
      await expect(
        frame.getByRole('button', { name: 'User filter', exact: true }),
      ).toHaveText('Fixture');
      await frame
        .getByRole('button', { name: 'Clear user filter' })
        .click({ timeout: 5000 });
      stage = 'select date';
      await vscode.commands.executeCommand('notifications.hideToasts');
      await frame
        .getByRole('button', { name: 'Date filter', exact: true })
        .click({ timeout: 5000 });
      await vscode.commands.executeCommand('notifications.hideToasts');
      await frame
        .getByRole('button', { name: 'Last 7 days', exact: true })
        .click({ timeout: 5000 });
      await expect(
        frame.getByRole('button', { name: 'Date filter', exact: true }),
      ).toHaveText('Last 7 days');
      await frame
        .getByRole('button', { name: 'Clear date filter' })
        .click({ timeout: 5000 });
      await expect(row).toHaveAttribute('data-sha', head);
      stage = 'open selected branch history and commit details';
      const targetBranch = frame.getByRole('treeitem', {
        name: 'nav-target',
        exact: true,
      });

      await targetBranch.dblclick({ timeout: 5000 });
      await expect(frame.locator('#scope')).toHaveText('nav-target');
      await expect(row).toHaveAttribute('data-sha', target);
      await row.click({ timeout: 5000 });
      const info = frame.locator('[data-commit-info]');

      await expect(info.getByRole('link')).toHaveAttribute(
        'href',
        'mailto:fixture%40example.test',
      );
      await expect(info.locator('time')).toHaveCount(1);
      await expect(info).toContainText('Committed');
      const refs = info.getByRole('group', {
        name: 'Branches and tags at this commit',
      });

      await expect(refs).toContainText('nav-target');
      await expect(refs).toContainText('v-header');
      await refs.scrollIntoViewIfNeeded({ timeout: 5000 });
      await frame.page().screenshot({
        path: '.artifacts/commit-reference-groups-native.png',
      });
      stage = 'reveal current branch without selecting it';
      await branchSearch.fill('nav-target', { timeout: 5000 });
      await frame
        .getByRole('button', { name: 'Reveal Current Branch', exact: true })
        .click({ timeout: 5000 });
      await expect(branchSearch).toHaveValue('');
      await expect(targetBranch).toHaveAttribute('aria-selected', 'true');
      await expect(
        frame.getByRole('treeitem', {
          name: 'main (Current branch)',
          exact: true,
        }),
      ).toHaveAttribute('aria-selected', 'false');
      await frame
        .page()
        .screenshot({ path: '.artifacts/commit-presentation-native.png' });
      stage = 'show current branch history on double-click';
      await expect(frame.locator('#scope')).toHaveText('nav-target');
      await frame
        .getByRole('button', { name: 'Reveal Current Branch', exact: true })
        .dblclick({ timeout: 5000 });
      await expect(frame.locator('#scope')).toHaveText('main');
      await expect(row).toHaveAttribute('data-sha', head);
      await expect(
        frame.getByRole('treeitem', {
          name: 'main (Current branch)',
          exact: true,
        }),
      ).toHaveAttribute('aria-selected', 'true');
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
    } catch (error) {
      await writeFile(
        join(
          process.env.GIT_UI_TEST_ARTIFACTS ?? '.artifacts',
          'header-native-failure.json',
        ),
        JSON.stringify(
          {
            stage,
            view: frame
              ? await frame
                  .evaluate(() => ({
                    focus: document.activeElement?.outerHTML,
                    text: document.body.innerText,
                    history: document
                      .querySelector('[data-commit-row]')
                      ?.getAttribute('data-vscode-context'),
                  }))
                  .catch(() => null)
              : null,
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      if (frame) {
        if (await frame.page().locator('.quick-input-widget').isVisible())
          await frame
            .page()
            .keyboard.press('Escape')
            .catch(() => {});
        const show = frame.getByRole('button', { name: 'Show Git Branches' });

        if (await show.count())
          await show.click({ timeout: 1000 }).catch(() => {});
        for (const name of ['Clear user filter', 'Clear date filter']) {
          const clear = frame.getByRole('button', { name });

          if (await clear.count())
            await clear.click({ timeout: 1000 }).catch(() => {});
        }
      }

      await fixture.dispose();
    }
  });
});
