import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { commandId } from '../../src/shared/extension-identity';
import {
  annotationPoint,
  nativeHover,
  workbench,
} from '../fixtures/native-blame';
import { nativePanel } from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';

describe('native Blame editor', () => {
  it('opens the exact commit and original file from ordinary date and author clicks', async function () {
    this.timeout(60000);
    const fixture = await createFixture({ prefix: 'git-ui-blame-click-' });
    const original = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    const path = join(fixture.root, 'renamed.txt');

    try {
      await fixture.runGit(['mv', 'sample.txt', 'renamed.txt']);
      await fixture.runGit(['commit', '-m', 'Rename the sample']);
      await writeFile(path, 'first\nsecond\n');
      await fixture.runGit(['add', 'renamed.txt']);
      await fixture.runGit([
        'commit',
        '--author',
        'Second Author <second@example.test>',
        '-m',
        'Add a second line',
      ]);
      const head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(fixture.root),
      );

      assert.ok(repository);
      await repository.status();
      const editor = await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(path),
        { preview: false },
      );

      assert.equal(
        await vscode.commands.executeCommand(commandId('annotate-blame')),
        true,
      );
      const page = await workbench();
      const native = page
        .locator('.monaco-editor')
        .filter({ has: page.locator('.view-line', { hasText: 'second' }) })
        .last();
      const point = await annotationPoint(native, 'Fixture');

      // Move the caret into code so the annotation click changes selection.
      await page.mouse.click(point.codeX, point.y);
      await page.mouse.click(point.x, point.y);
      const frame = await nativePanel(repository.rootUri.toString());

      await expect(
        frame.locator(`[data-commit-row][data-sha="${original}"]`),
      ).toHaveAttribute('aria-selected', 'true');
      const file = frame.locator(
        '#details[aria-busy="false"] [data-path="sample.txt"]',
      );

      await expect(file).toHaveAttribute('aria-selected', 'true');
      await expect(file).toBeInViewport();
      await vscode.window.showTextDocument(editor.document, editor.viewColumn);
      const author = await annotationPoint(native, 'Author');

      await page.mouse.click(author.codeX - 70, author.y);
      await expect(
        frame.locator(`[data-commit-row][data-sha="${head}"]`),
      ).toHaveAttribute('aria-selected', 'true');
      await expect(
        frame.locator('#details[aria-busy="false"] [data-path="renamed.txt"]'),
      ).toHaveAttribute('aria-selected', 'true');
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
      assert.equal(editor.document.getText(), 'first\nsecond\n');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fixture.dispose();
    }
  });
  it('the line commit command repeatedly reveals and highlights the file at its original name', async function () {
    this.timeout(60000);
    const fixture = await createFixture({ prefix: 'git-ui-blame-renamed-' });
    const path = join(fixture.root, 'renamed.txt');
    const original = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

    try {
      await fixture.runGit(['mv', 'sample.txt', 'renamed.txt']);
      await fixture.runGit(['commit', '-m', 'Rename the sample']);
      const head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(fixture.root),
      );

      assert.ok(repository);
      await repository.status();
      const editor = await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(path),
        { preview: false },
      );

      assert.equal(
        await vscode.commands.executeCommand(commandId('annotate-blame')),
        true,
      );
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      assert.equal(
        await vscode.commands.executeCommand(
          commandId('open-current-blame-commit'),
        ),
        true,
      );
      const frame = await nativePanel(repository.rootUri.toString());

      await expect(
        frame.locator(`[data-commit-row][data-sha="${original}"]`),
      ).toHaveAttribute('aria-selected', 'true');
      const file = frame.locator(
        '#details[aria-busy="false"] [data-path="sample.txt"]',
      );

      await expect(file).toHaveAttribute('aria-selected', 'true');
      await expect(file).toBeInViewport();
      await vscode.window.showTextDocument(editor.document, editor.viewColumn);
      assert.equal(
        await vscode.commands.executeCommand(
          commandId('open-current-blame-commit'),
        ),
        true,
      );
      await expect(file).toHaveAttribute('aria-selected', 'true');
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
      assert.equal(editor.document.uri.fsPath, vscode.Uri.file(path).fsPath);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fixture.dispose();
    }
  });
  it('keeps the source tab, syntax and text while displaying aligned tinted annotations', async function () {
    this.timeout(60000);
    const fixture = await createFixture({ prefix: 'git-ui-blame-native-' });
    const path = join(fixture.root, 'annotated.ts');
    const contents =
      'export const answer = 42;\nexport const next = answer + 1;\n';

    try {
      await writeFile(path, contents);
      await fixture.runGit(['add', 'annotated.ts']);
      await fixture.runGit(['commit', '-m', 'Add typed answers']);
      const access = await getGitApi();

      const repository = await access.api.openRepository(
        vscode.Uri.file(fixture.root),
      );

      assert.ok(repository);
      await repository.status();
      const editor = await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(path),
        { preview: false },
      );
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;

      assert.equal(
        await vscode.commands.executeCommand(commandId('annotate-blame')),
        true,
      );
      assert.equal(vscode.window.activeTextEditor, editor);
      assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab, tab);
      assert.equal(editor.document.getText(), contents);
      assert.equal(editor.document.languageId, 'typescript');
      const page = await workbench();
      const native = page
        .locator('.monaco-editor')
        .filter({
          has: page.locator('.view-line', { hasText: 'export const answer' }),
        })
        .last();

      await expect
        .poll(() =>
          native
            .locator('.view-line')
            .first()
            .evaluate((row) =>
              [...row.querySelectorAll('span')].some((span) => {
                const style = getComputedStyle(span, '::before');

                return (
                  /\d{2}\.\d{2}\.\d{4}/.test(style.content) &&
                  style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                  Number.parseFloat(style.width) > 100
                );
              }),
            ),
        )
        .toBe(true);
      const hover = await nativeHover(native, 'Fixture');

      await expect(hover).toContainText('Add typed answers');
      await page.screenshot({ path: '.artifacts/blame-native-editor.png' });
    } finally {
      await vscode.commands.executeCommand(commandId('close-blame'));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fixture.dispose();
    }
  });
});
