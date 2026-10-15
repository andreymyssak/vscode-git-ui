import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { commandId, LOG_VIEW_ID } from '../../src/shared/extension-identity';
import {
  refreshNativeHistory,
  selectNativeRepository,
} from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';

it('Delete shows progress while local Git is pending and removes its branch automatically', async function () {
  this.timeout(60000);
  const f = await createFixture({ prefix: 'git-ui-delete-progress-' });
  const started = f.root + '.started';
  const release = f.root + '.release';
  const script = f.root + '.hook.cjs';
  let pending: Promise<unknown> | undefined;

  try {
    await f.runGit(['branch', 'delete-me']);
    const access = await getGitApi();
    const id = vscode.Uri.file(f.root).toString();

    await access.api.openRepository(vscode.Uri.file(f.root));
    await access.repository(id).status();
    await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
    const frame = await selectNativeRepository(id);

    await refreshNativeHistory(frame, id);
    const row = frame.locator('[data-ref="refs/heads/delete-me"]');

    await expect(row).toBeVisible();
    const context: unknown = JSON.parse(
      (await row.getAttribute('data-vscode-context'))!,
    );

    await writeFile(
      script,
      `const fs = require('node:fs');
if (process.argv[2] !== 'prepared') process.exit(0);
fs.writeFileSync(${JSON.stringify(started)}, 'started');
const deadline = Date.now() + 25000;
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) process.exit(0);
  if (Date.now() > deadline) process.exit(1);
}, 25);
`,
    );
    const quote = (path: string) =>
      `'${path.replaceAll('\\', '/').replaceAll("'", "'\"'\"'")}'`;

    await writeFile(
      join(f.root, '.git/hooks/reference-transaction'),
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(script)} "$@"\n`,
      { mode: 0o755 },
    );
    pending = Promise.resolve(
      vscode.commands.executeCommand(commandId('delete-branch'), context),
    );
    await expect.poll(() => existsSync(started)).toBe(true);
    await expect(row.getByLabel('Deleting delete-me…')).toBeVisible();
    await expect(frame.locator('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await vscode.commands.executeCommand(commandId('delete-branch'), context);
    await expect(row).toBeVisible();
    await writeFile(release, 'go');
    await pending;
    await expect(row).toHaveCount(0);
    await expect(frame.locator('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    assert.equal((await f.runGit(['branch', '--show-current'])).trim(), 'main');
  } finally {
    await writeFile(release, 'go');
    await pending?.catch(() => {});
    await vscode.commands.executeCommand('notifications.clearAll');
    await f.dispose();
    await Promise.all(
      [started, release, script].map((path) => rm(path, { force: true })),
    );
  }
});

it('New Branch and Checkout shows pending feedback and refreshes the current branch', async () => {
  const f = await createFixture({ prefix: 'git-ui-create-progress-' });
  let pending: Promise<unknown> | undefined;

  try {
    const access = await getGitApi();
    const id = vscode.Uri.file(f.root).toString();

    await access.api.openRepository(vscode.Uri.file(f.root));
    await access.repository(id).status();
    await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
    const frame = await selectNativeRepository(id);

    await refreshNativeHistory(frame, id);
    const row = frame.locator('[data-ref="refs/heads/main"]');
    const context: unknown = JSON.parse(
      (await row.getAttribute('data-vscode-context'))!,
    );

    pending = Promise.resolve(
      vscode.commands.executeCommand(
        commandId('create-branch-checkout'),
        context,
      ),
    );
    const input = frame.page().locator('.quick-input-widget input:visible');

    await expect(input).toBeVisible();
    await expect(
      row.getByLabel('Creating and checking out branch…'),
    ).toBeVisible();
    await expect(frame.locator('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await input.fill('new-progress-branch');
    await input.press('Enter');
    await pending;
    await expect(
      frame.locator('[data-current="true"] [data-reference-name]'),
    ).toHaveText('new-progress-branch');
    await expect(frame.locator('#scope')).toHaveText('new-progress-branch');
    await expect(frame.locator('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    assert.equal(
      (await f.runGit(['branch', '--show-current'])).trim(),
      'new-progress-branch',
    );
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await pending?.catch(() => {});
    await f.dispose();
  }
});
