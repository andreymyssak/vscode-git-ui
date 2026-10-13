import assert from 'node:assert/strict';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { LOG_VIEW_ID } from '../../src/shared/extension-identity';
import { selectNativeRepository } from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';
import { sourceControlFrame } from '../fixtures/source-control-view';

describe('native webview accessibility', () => {
  it('keeps interactive panels outside live regions and follows the editor motion preference', async () => {
    const fixture = await createFixture({ prefix: 'git-ui accessibility ' });
    const configuration = vscode.workspace.getConfiguration('workbench');
    const previous = configuration.inspect<string>('reduceMotion')?.globalValue;

    try {
      const access = await getGitApi();

      await access.api.openRepository(vscode.Uri.file(fixture.root));
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      const log = await selectNativeRepository(
        vscode.Uri.file(fixture.root).toString(),
      );

      assert.equal(
        await log
          .locator('#history')
          .evaluate(
            (node) => node.closest('[aria-live], [role="status"]') !== null,
          ),
        false,
      );
      await expect(log.locator('[data-commit-row]').first()).toHaveAttribute(
        'aria-rowindex',
        '1',
      );
      await expect(log.locator('#history')).toHaveAttribute(
        'aria-rowcount',
        '1',
      );
      await configuration.update(
        'reduceMotion',
        'on',
        vscode.ConfigurationTarget.Global,
      );
      await expect
        .poll(() =>
          log.evaluate(() =>
            document.body.classList.contains('vscode-reduce-motion'),
          ),
        )
        .toBe(true);
      const animation = await log.locator('#history-pane').evaluate((node) => {
        node.setAttribute('aria-busy', 'true');

        return getComputedStyle(node, '::before').animationName;
      });

      assert.equal(animation, 'none');
      await log
        .locator('#history-pane')
        .evaluate((node) => node.setAttribute('aria-busy', 'false'));
      const changes = await sourceControlFrame();

      assert.equal(
        await changes
          .locator('[data-source-control]')
          .evaluate(
            (node) => node.closest('[aria-live], [role="status"]') !== null,
          ),
        false,
      );
    } finally {
      await configuration.update(
        'reduceMotion',
        previous,
        vscode.ConfigurationTarget.Global,
      );
      await fixture.dispose();
    }
  });
});
