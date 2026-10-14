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
import {
  commitLinearHistory,
  createFixture,
  type Fixture,
} from '../fixtures/repository';

describe('native graph interactions', () => {
  it('keeps the first commit message next to its graph when an older merge has many lanes', async () => {
    const fixture = await createFixture({
      prefix: 'git-ui-native row graph widths ',
    });
    const root = vscode.Uri.file(fixture.root);

    try {
      const base = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const tree = (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
      const parents: string[] = [];

      for (let index = 0; index < 12; index++)
        parents.push(
          (
            await fixture.runGit([
              'commit-tree',
              tree,
              '-p',
              base,
              '-m',
              `Branch ${index}`,
            ])
          ).trim(),
        );
      const merge = (
        await fixture.runGit([
          'commit-tree',
          tree,
          ...parents.flatMap((sha) => ['-p', sha]),
          '-m',
          'Wide merge',
        ])
      ).trim();
      const headSha = await commitLinearHistory(
        fixture,
        merge,
        Array.from({ length: 45 }, (_, index) => ({
          message: `Narrow row ${index + 1}`,
          date: `${Date.UTC(2026, 9, 14, 9, index) / 1000} +0000`,
        })),
      );

      await fixture.runGit(['update-ref', 'refs/heads/main', headSha, base]);
      const access = await getGitApi();

      await access.api.openRepository(root);
      await access.repository(root.toString()).status();
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      const frame = await selectNativeRepository(root.toString());
      const head = await refreshNativeHistory(frame, root.toString());

      await expect(head).toHaveAttribute('data-sha', headSha);
      const geometry = await head.evaluate((node) => {
        const graph = node.querySelector('[data-commit-graph]');
        const message = node.querySelector('[data-subject-message]');

        if (!graph || !message) throw new Error('History row did not render');
        const bounds = graph.getBoundingClientRect();

        return {
          graphWidth: bounds.width,
          graphRight: bounds.right,
          messageLeft: message.getBoundingClientRect().left,
        };
      });

      assert.equal(geometry.graphWidth, 22);
      assert.ok(Math.abs(geometry.messageLeft - geometry.graphRight) < 1);
      await expect(head.locator('[data-author]')).toContainText('Fixture');
      await expect(head.locator('[data-date]')).toBeVisible();
    } finally {
      await fixture.dispose();
    }
  });

  it('marks the checkout and opens details through graph dots without a hover popup', async () => {
    const fixture = await createFixture({
      prefix: 'git-ui-native graph hover ',
    });
    const rootUri = vscode.Uri.file(fixture.root);
    let previous: Fixture | undefined;

    try {
      await writeFile(join(fixture.root, 'sample.txt'), 'graph update\n');
      await fixture.runGit(['add', '.']);
      await fixture.runGit([
        'commit',
        '-m',
        'Graph hover subject',
        '-m',
        'Full commit body',
      ]);
      const headSha = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const parentSha = (await fixture.runGit(['rev-parse', 'HEAD^'])).trim();
      const access = await getGitApi();

      previous = await createFixture({ prefix: 'git-ui-native prior graph ' });
      await access.api.openRepository(vscode.Uri.file(previous.root));
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      await selectNativeRepository(vscode.Uri.file(previous.root).toString());
      await access.api.openRepository(rootUri);
      await access.repository(rootUri.toString()).status();
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      const frame = await selectNativeRepository(rootUri.toString());
      const head = await refreshNativeHistory(frame, rootUri.toString());

      await expect(head).toHaveAttribute('data-sha', headSha);
      await expect(head.locator('svg circle')).toHaveCount(2);
      const parent = frame.locator(
        `[data-commit-row][data-sha="${parentSha}"]`,
      );

      await head.press('ArrowDown');
      await expect(parent).toBeFocused();
      await frame.page().keyboard.press('ArrowUp');
      await expect(head).toBeFocused();
      await expect(head).toHaveAccessibleDescription(/Current checkout/);
      await head.locator('[data-commit-graph]').hover();
      await expect(frame.getByRole('tooltip')).toHaveCount(0);
      await head.locator('[data-commit-graph]').click();
      await expect(head).toHaveAttribute('aria-selected', 'true');
      await expect(frame.locator('#details')).toContainText('sample.txt');
      await expect(frame.locator('#details')).toContainText('Full commit body');
      await expect(frame.locator('#details')).toContainText(
        'fixture@example.test',
      );
      await parent.locator('[data-commit-graph]').click();
      await expect(parent).toHaveAttribute('aria-selected', 'true');
      await expect(head).toHaveAttribute('aria-selected', 'false');
      await expect(head.locator('svg circle')).toHaveCount(2);
      assert.equal(
        (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
        headSha,
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await previous?.dispose();
      await fixture.dispose();
    }
  });
});
