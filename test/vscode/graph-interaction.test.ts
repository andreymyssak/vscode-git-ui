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
import { createFixture, type Fixture } from '../fixtures/repository';

describe('native graph interactions', () => {
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
