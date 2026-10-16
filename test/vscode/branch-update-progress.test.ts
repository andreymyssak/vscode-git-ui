import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { commandId, LOG_VIEW_ID } from '../../src/shared/extension-identity';
import { divergentFixture } from '../fixtures/branch-update';
import {
  refreshNativeHistory,
  selectNativeRepository,
} from '../fixtures/native-panel';

it('Log queues a second branch Update during a real slow fetch and settles both automatically', async function () {
  this.timeout(60000);
  const f = await divergentFixture('topic');
  const script = f.remote + '.upload-pack.cjs';
  const started = f.remote + '.started';
  const release = f.remote + '.release';
  let operation: Promise<unknown> | undefined;
  let queued: Promise<unknown> | undefined;

  try {
    await f.runGit(['update-ref', 'refs/heads/topic', f.base, f.local]);
    await f.runGit(['branch', 'second', f.base]);
    await f.runGit(['branch', '--set-upstream-to=origin/main', 'second']);
    // A gated local transport keeps the real native fetch pending without network timing.
    await writeFile(
      script,
      `const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.appendFileSync(${JSON.stringify(started)}, 'fetch\\n');
const deadline = Date.now() + 25000;
const timer = setInterval(() => {
  if (Date.now() > deadline) process.exit(1);
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer);
  const child = spawn('git-upload-pack', process.argv.slice(2), { stdio: 'inherit' });
  child.once('error', () => process.exit(1));
  child.once('exit', code => process.exit(code ?? 1));
}, 25);
`,
    );
    const quote = (path: string) =>
      `'${path.replaceAll('\\', '/').replaceAll("'", "'\"'\"'")}'`;

    await f.runGit([
      'config',
      'remote.origin.uploadpack',
      `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(script)}`,
    ]);
    await f.access.repository(f.id).status();
    await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
    const frame = await selectNativeRepository(f.id);

    await refreshNativeHistory(frame, f.id);
    const branch = frame.locator('[data-ref="refs/heads/topic"]');
    const rows = frame.locator('[data-commit-row]');
    const before = await rows.count();

    await expect(branch).toHaveAttribute(
      'data-vscode-context',
      /"refCanUpdate":true/,
    );
    const context: unknown = JSON.parse(
      (await branch.getAttribute('data-vscode-context')) ?? 'null',
    );

    await vscode.commands.executeCommand('notifications.clearAll');
    operation = Promise.resolve(
      vscode.commands.executeCommand(commandId('update-branch'), context),
    );
    await expect.poll(() => existsSync(started)).toBe(true);
    await expect(branch.getByLabel('Updating topic…')).toBeVisible();
    await expect(frame.locator('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await expect(rows).toHaveCount(before);
    await expect(rows.first()).toBeVisible();
    await expect(frame.locator('#history')).not.toHaveAttribute('inert', '');
    // Even a command dispatched from an already-open native menu cannot queue another fetch.
    await vscode.commands.executeCommand(commandId('update-branch'), context);
    assert.equal(await readFile(started, 'utf8'), 'fetch\n');
    await expect(branch.getByLabel('Updating topic…')).toBeVisible();
    await expect(frame.page().locator('.notification-list-item')).toHaveCount(
      0,
    );
    const second = frame.locator('[data-ref="refs/heads/second"]');

    await expect(second).toHaveAttribute(
      'data-vscode-context',
      /"refCanUpdate":true/,
    );
    const secondContext: unknown = JSON.parse(
      (await second.getAttribute('data-vscode-context'))!,
    );

    queued = Promise.resolve(
      vscode.commands.executeCommand(commandId('update-branch'), secondContext),
    );
    await expect(second.getByLabel('Queued: Updating second…')).toBeVisible();
    await expect(second.locator('.codicon-loading')).toBeVisible();
    // Neither a second native request nor another branch starts a concurrent fetch.
    await vscode.commands.executeCommand(
      commandId('update-branch'),
      secondContext,
    );
    assert.equal(await readFile(started, 'utf8'), 'fetch\n');
    await writeFile(release, 'go');
    await operation;
    await queued;
    await expect(branch.locator('.codicon-loading')).toHaveCount(0);
    await expect(frame.locator('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await expect(branch.locator('[data-incoming]')).toHaveCount(0);
    assert.equal((await f.runGit(['rev-parse', 'topic'])).trim(), f.incoming);
    assert.equal((await f.runGit(['branch', '--show-current'])).trim(), 'main');
    assert.equal((await f.runGit(['rev-parse', 'second'])).trim(), f.incoming);
    assert.equal(await readFile(started, 'utf8'), 'fetch\nfetch\n');
  } finally {
    await writeFile(release, 'go');
    await operation?.catch(() => {});
    await queued?.catch(() => {});
    await vscode.commands.executeCommand('notifications.clearAll');
    await f.dispose();
    await Promise.all(
      [script, started, release].map((path) => rm(path, { force: true })),
    );
  }
});
