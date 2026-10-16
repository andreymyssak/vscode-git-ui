import assert from 'node:assert/strict';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { commandId, LOG_VIEW_ID } from '../../src/shared/extension-identity';
import { divergentFixture } from '../fixtures/branch-update';
import {
  refreshNativeHistory,
  selectNativeRepository,
} from '../fixtures/native-panel';

it('a blocked Update stops while its error notification remains open and checkout stays optional', async function () {
  this.timeout(60000);
  const f = await divergentFixture('feature/local-experiment');
  let pending: Promise<unknown> | undefined;

  try {
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
    const frame = await selectNativeRepository(f.id);

    await refreshNativeHistory(frame, f.id);
    await frame.locator('#reference-search').fill('feature/local-experiment');
    const branch = frame.locator(
      '[data-ref="refs/heads/feature/local-experiment"]',
    );

    await expect(branch).toHaveAttribute(
      'data-vscode-context',
      /"refCanUpdate":true/,
    );
    const context: unknown = JSON.parse(
      (await branch.getAttribute('data-vscode-context'))!,
    );

    pending = Promise.resolve(
      vscode.commands.executeCommand(commandId('update-branch'), context),
    );
    const notification = frame
      .page()
      .locator('.notification-list-item')
      .filter({ hasText: 'has local commits and incoming changes' });

    await expect(notification).toBeVisible();
    await expect(
      notification.getByRole('button', {
        name: 'Checkout Branch',
        exact: true,
      }),
    ).toBeVisible();
    await vscode.commands.executeCommand('notifications.showList');
    await expect(
      frame.page().locator('.quick-input-widget:visible'),
    ).toHaveCount(0);
    await pending;
    await expect(frame.locator('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await expect(branch.locator('.codicon-loading')).toHaveCount(0);
    await expect(notification).toBeVisible();
    assert.equal(
      (await f.runGit(['rev-parse', 'feature/local-experiment'])).trim(),
      f.local,
    );
    assert.equal((await f.runGit(['branch', '--show-current'])).trim(), 'main');
    await notification
      .getByRole('button', { name: 'Checkout Branch', exact: true })
      .click();
    await expect(frame.locator('#scope')).toHaveText(
      'feature/local-experiment',
    );
    await expect
      .poll(async () => (await f.runGit(['branch', '--show-current'])).trim())
      .toBe('feature/local-experiment');
    await expect(frame.locator('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await pending?.catch(() => {});
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('notifications.hideList');
    await f.dispose();
  }
});

it('a current divergent Update ends before an optional Merge starts', async function () {
  this.timeout(60000);
  const f = await divergentFixture('main');

  try {
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
    const frame = await selectNativeRepository(f.id);

    await refreshNativeHistory(frame, f.id);
    const branch = frame.locator('[data-ref="refs/heads/main"]');

    await expect(branch).toHaveAttribute(
      'data-vscode-context',
      /"refCanUpdate":true/,
    );
    const context: unknown = JSON.parse(
      (await branch.getAttribute('data-vscode-context'))!,
    );

    await vscode.commands.executeCommand(commandId('update-branch'), context);
    await vscode.commands.executeCommand('notifications.showList');
    const notification = frame
      .page()
      .locator('.notification-list-item')
      .filter({ hasText: 'Choose Rebase or Merge' });

    await expect(notification).toBeVisible();
    await expect(
      frame.page().locator('.quick-input-widget:visible'),
    ).toHaveCount(0);
    await expect(branch.locator('.codicon-loading')).toHaveCount(0);
    await expect(frame.locator('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    assert.equal((await f.runGit(['rev-parse', 'HEAD'])).trim(), f.local);
    await notification
      .getByRole('button', { name: 'Merge', exact: true })
      .click();
    await expect
      .poll(async () => (await f.runGit(['rev-parse', 'HEAD'])).trim())
      .not.toBe(f.local);
    await expect(frame.locator('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const parents = (await f.runGit(['show', '-s', '--format=%P', 'HEAD']))
      .trim()
      .split(' ');

    assert.deepEqual(parents, [f.local, f.incoming]);
  } finally {
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('notifications.hideList');
    await f.dispose();
  }
});
