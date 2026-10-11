import assert from 'node:assert/strict';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { createBlameQueries } from '../../src/extension/git/blame';
import { GitCli } from '../../src/extension/git/cli';
import { BlameAnnotations } from '../../src/extension/native/blame-annotations';
import { deferred } from '../fixtures/deferred';
import { annotationPoint, workbench } from '../fixtures/native-blame';
import { createFixture } from '../fixtures/repository';

async function setup(beforeRead?: () => Promise<void>) {
  const fixture = await createFixture({ prefix: 'git-ui-blame-owner-' });
  const access = await getGitApi();
  const repository = await access.api.openRepository(
    vscode.Uri.file(fixture.root),
  );

  assert.ok(repository);
  await repository.status();
  const stable = {
    ...access,
    repository: (id: string) =>
      id === repository.rootUri.toString() ? repository : access.repository(id),
  };
  const document = await vscode.workspace.openTextDocument(
    join(fixture.root, 'sample.txt'),
  );
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.One,
  });
  let reads = 0;
  let navigations = 0;
  const reader = createBlameQueries(stable, new GitCli(stable));
  const annotations = new BlameAnnotations({
    getAccess: async () => stable,
    readBlame: async (query, signal) => {
      reads++;
      await beforeRead?.();

      return reader(query, signal);
    },
    openCommit: async () => {
      navigations++;
    },
  });

  return {
    document,
    editor,
    annotations,
    repository,
    reads: () => reads,
    navigations: () => navigations,
    async dispose() {
      annotations.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand(
        'workbench.action.editorLayoutSingle',
      );
      await fixture.dispose();
    },
  };
}

describe('Blame editor ownership', () => {
  it('releases a moved tab when its pending initial read fails', async () => {
    const gate = deferred<void>();
    const f = await setup(async () => {
      await gate.promise;
      throw new Error('Git read failed');
    });

    try {
      const result = f.annotations.annotate(f.editor).then(
        () => null,
        (error: unknown) => error,
      );

      await expect.poll(f.reads).toBe(1);
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument({
          content: 'keep source group',
        }),
        { viewColumn: vscode.ViewColumn.One, preview: false },
      );
      await vscode.window.showTextDocument(f.document, {
        viewColumn: vscode.ViewColumn.One,
      });
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument({
          content: 'keep destination group',
        }),
        { viewColumn: vscode.ViewColumn.Two, preview: false },
      );
      await vscode.window.showTextDocument(f.document, {
        viewColumn: vscode.ViewColumn.One,
      });
      await vscode.commands.executeCommand(
        'workbench.action.moveEditorToNextGroup',
      );
      await expect
        .poll(() =>
          vscode.window.visibleTextEditors.some(
            (editor) =>
              editor.document === f.document &&
              editor.viewColumn === vscode.ViewColumn.Two &&
              f.annotations.isEnabled(editor),
          ),
        )
        .toBe(true);
      const moved = vscode.window.visibleTextEditors.find(
        (editor) => editor.document === f.document,
      );

      assert.ok(moved);
      gate.resolve();
      const error = await result;

      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Git read failed');
      assert.equal(f.annotations.isEnabled(moved), false);
      const before = f.reads();

      await f.repository.status();
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(f.reads(), before);
    } finally {
      gate.resolve();
      await f.dispose();
    }
  });
  it('the active diff owns annotations independently of an earlier normal file tab', async () => {
    const f = await setup();

    try {
      const access = await getGitApi();

      await vscode.commands.executeCommand(
        'vscode.diff',
        access.api.toGitUri(f.document.uri, 'HEAD'),
        f.document.uri,
        'Owned diff',
        { preview: false, viewColumn: vscode.ViewColumn.One },
      );
      const diff = vscode.window.tabGroups.activeTabGroup.activeTab;

      assert.ok(diff?.input instanceof vscode.TabInputTextDiff);
      const editor = vscode.window.visibleTextEditors.find(
        (editor) => editor.document === f.document,
      );

      assert.ok(editor);
      await f.annotations.annotate(editor);
      const normal = diff.group.tabs.find(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === f.document.uri.toString(),
      );

      assert.ok(normal);
      await vscode.window.tabGroups.close(normal, true);
      await expect.poll(() => f.annotations.isEnabled(editor)).toBe(true);
      await vscode.window.tabGroups.close(diff, true);
      await expect.poll(() => f.annotations.isEnabled(editor)).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('hiding an annotated diff behind its normal file does not annotate that preexisting tab', async () => {
    const f = await setup();

    try {
      const access = await getGitApi();

      await vscode.commands.executeCommand(
        'vscode.diff',
        access.api.toGitUri(f.document.uri, 'HEAD'),
        f.document.uri,
        'Hidden diff',
        { preview: false, viewColumn: vscode.ViewColumn.One },
      );
      const diff = vscode.window.tabGroups.activeTabGroup.activeTab;

      assert.ok(diff?.input instanceof vscode.TabInputTextDiff);
      const editor = vscode.window.visibleTextEditors.find(
        (editor) => editor.document === f.document,
      );

      assert.ok(editor);
      await f.annotations.annotate(editor);
      const normal = await vscode.window.showTextDocument(f.document, {
        viewColumn: vscode.ViewColumn.One,
      });

      await expect.poll(() => f.annotations.isEnabled(normal)).toBe(false);
      await vscode.window.tabGroups.close(diff, true);
      assert.equal(f.annotations.isEnabled(normal), false);
    } finally {
      await f.dispose();
    }
  });
  it('clicking the first source character does not navigate, while the explicit command does', async () => {
    const f = await setup();

    try {
      await f.annotations.annotate(f.editor);
      const page = await workbench();
      const native = page
        .locator('.monaco-editor')
        .filter({ has: page.locator('.view-line', { hasText: /^first$/ }) })
        .last();
      const point = await annotationPoint(native, 'Fixture');

      f.editor.selection = new vscode.Selection(0, 2, 0, 2);
      await page.mouse.click(point.codeX - 15, point.y);
      await expect.poll(() => f.editor.selection.active.character).toBe(0);
      assert.equal(f.navigations(), 0);
      await f.annotations.openCurrentCommit(f.editor);
      await f.annotations.openCurrentCommit(f.editor);
      assert.equal(f.navigations(), 2);
    } finally {
      await f.dispose();
    }
  });
  it('releases a closed split while its document remains open elsewhere', async () => {
    const f = await setup();

    try {
      await f.annotations.annotate(f.editor);
      const split = await vscode.window.showTextDocument(f.document, {
        preview: false,
        viewColumn: vscode.ViewColumn.Two,
      });

      await f.annotations.annotate(split);
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;

      assert.ok(tab);
      await vscode.window.tabGroups.close(tab, true);
      await expect.poll(() => f.annotations.isEnabled(split)).toBe(false);
      assert.equal(f.document.isClosed, false);
      const before = f.reads();

      await f.repository.status();
      await expect.poll(f.reads).toBe(before + 1);
      assert.equal(f.annotations.isEnabled(f.editor), true);
    } finally {
      await f.dispose();
    }
  });

  it('follows a moved annotated tab without enabling a preexisting copy', async () => {
    const f = await setup();

    try {
      await f.annotations.annotate(f.editor);
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument({
          content: 'keep source group',
        }),
        { viewColumn: vscode.ViewColumn.One, preview: false },
      );
      await vscode.window.showTextDocument(f.document, {
        viewColumn: vscode.ViewColumn.One,
      });
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument({
          content: 'keep destination group',
        }),
        { viewColumn: vscode.ViewColumn.Two, preview: false },
      );
      await vscode.window.showTextDocument(f.document, {
        viewColumn: vscode.ViewColumn.One,
      });
      await vscode.commands.executeCommand(
        'workbench.action.moveEditorToNextGroup',
      );
      await expect
        .poll(() =>
          vscode.window.visibleTextEditors.some(
            (editor) =>
              editor.document === f.document &&
              editor.viewColumn === vscode.ViewColumn.Two &&
              f.annotations.isEnabled(editor),
          ),
        )
        .toBe(true);
      assert.equal(f.annotations.isEnabled(f.editor), false);
    } finally {
      await f.dispose();
    }
  });

  it('closing an annotated split does not transfer ownership to an existing unannotated copy', async () => {
    const f = await setup();

    try {
      await f.annotations.annotate(f.editor);
      const copy = await vscode.window.showTextDocument(f.document, {
        viewColumn: vscode.ViewColumn.Two,
        preview: false,
      });

      await vscode.window.showTextDocument(f.document, {
        viewColumn: vscode.ViewColumn.One,
      });
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;

      assert.ok(tab);
      await vscode.window.tabGroups.close(tab, true);
      await expect.poll(() => f.annotations.isEnabled(f.editor)).toBe(false);
      assert.equal(f.annotations.isEnabled(copy), false);
    } finally {
      await f.dispose();
    }
  });
});
