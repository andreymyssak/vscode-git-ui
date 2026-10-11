import assert from 'node:assert/strict';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { showOperationError } from '../../src/extension/native/operation-feedback';
import { fixture } from '../fixtures/controller';
import { nativeBrowser } from '../fixtures/native-panel';

describe('Log native failure notifications', () => {
  it('history failures and invalid date ranges appear in the VS Code notification stack', async () => {
    const browser = await nativeBrowser();
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) =>
        candidate.url().includes('/workbench/workbench.html'),
      );

    assert.ok(page);
    await vscode.commands.executeCommand('notifications.clearAll');
    const f = fixture(true, true, { reportActionError: showOperationError });

    try {
      await f.controller.selectRepository('one');
      f.adapter.history = async () => {
        throw new Error('Fixture Log history unavailable');
      };

      await f.controller.refresh();
      await f.controller.refresh();
      await vscode.commands.executeCommand('notifications.showList');
      const notifications = page.locator('.notification-list-item');

      await expect(
        notifications.filter({ hasText: 'Fixture Log history unavailable' }),
      ).toHaveCount(1);
      await vscode.commands.executeCommand('notifications.clearAll');
      await f.controller.handle(f.request({ kind: 'refresh' }, 'one', 3));
      await f.controller.handle(
        f.request({ kind: 'invalid-date-filter' }, 'one', 4),
      );
      await vscode.commands.executeCommand('notifications.showList');

      await expect(
        notifications.filter({ hasText: 'Fixture Log history unavailable' }),
      ).toHaveCount(1);
      await expect(
        notifications.filter({
          hasText: 'Start date must be on or before end date.',
        }),
      ).toHaveCount(1);
    } finally {
      f.controller.dispose();
      await vscode.commands.executeCommand('notifications.clearAll');
      await vscode.commands.executeCommand('notifications.hideList');
    }
  });
});
