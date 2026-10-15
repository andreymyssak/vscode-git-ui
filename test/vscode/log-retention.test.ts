import assert from 'node:assert/strict';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { commandId, LOG_VIEW_ID } from '../../src/shared/extension-identity';
import {
  nativePanel,
  refreshNativeHistory,
  selectNativeRepository,
} from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';

it('switching to Terminal retains the Log and reflects an amend made while hidden', async () => {
  const f = await createFixture({ prefix: 'git-ui-log-retention-' });
  const terminal = vscode.window.createTerminal({
    name: 'Git UI retention test',
  });

  try {
    const access = await getGitApi();
    const id = vscode.Uri.file(f.root).toString();

    await access.api.openRepository(vscode.Uri.file(f.root));
    await access.repository(id).status();
    await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
    const frame = await selectNativeRepository(id);

    await refreshNativeHistory(frame, id);
    await expect(frame.locator('[data-commit-row]').first()).toContainText(
      'Initial',
    );
    await frame.evaluate(() => {
      document.body.dataset.retentionTest = 'keep-live-log';
    });
    terminal.show();
    await expect(
      frame.page().getByRole('tab', { name: /^Terminal(?:\s|$)/ }),
    ).toHaveAttribute('aria-selected', 'true');
    await f.runGit(['commit', '--amend', '-m', 'Amended while Log hidden']);
    const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

    await access.repository(id).status();
    await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
    const returned = await nativePanel(id);

    assert.equal(
      await returned.evaluate(() => document.body.dataset.retentionTest),
      'keep-live-log',
      'tab switches must retain the loaded document instead of rebuilding an empty Log',
    );
    await expect(returned.locator('[data-commit-row]').first()).toHaveAttribute(
      'data-sha',
      sha,
    );
    await expect(returned.locator('[data-commit-row]')).toHaveCount(1);
    await expect(returned.locator('[data-commit-row]').first()).toContainText(
      'Amended while Log hidden',
    );
    terminal.show();
    await expect(
      returned.page().getByRole('tab', { name: /^Terminal(?:\s|$)/ }),
    ).toHaveAttribute('aria-selected', 'true');
    const opened = await vscode.commands.executeCommand<boolean>(
      commandId('open-blame-commit'),
      {
        documentUri: vscode.Uri.file(join(f.root, 'sample.txt')).toString(),
        sha,
        filePath: 'sample.txt',
      },
    );

    assert.equal(
      opened,
      true,
      'Blame navigation must reconnect to the retained Log when it becomes visible',
    );
    await expect(
      returned.locator(`[data-sha="${sha}"][aria-selected="true"]`),
    ).toBeVisible();
    await expect(
      returned.locator('#details [data-path="sample.txt"]'),
    ).toBeVisible();
  } finally {
    terminal.dispose();
    await f.dispose();
  }
});
