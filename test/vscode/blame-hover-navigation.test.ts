import assert from 'node:assert/strict';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi, type GitAPI } from '../../src/extension/git/api';
import { commandId } from '../../src/shared/extension-identity';
import { nativeHover, workbench } from '../fixtures/native-blame';
import { nativePanel } from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';

describe('native Blame hover navigation', () => {
  it('navigates from a visible split editor after hiding another annotated copy', async function () {
    this.timeout(60000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    const fixture = await createFixture({
      prefix: 'git-ui-blame-split-hover-',
    });

    try {
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(fixture.root),
      );

      assert.ok(repository);
      await repository.status();
      const document = await vscode.workspace.openTextDocument(
        join(fixture.root, 'sample.txt'),
      );
      const sha = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const first = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });

      assert.equal(
        await vscode.commands.executeCommand(commandId('annotate-blame')),
        true,
      );
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Two,
        preview: false,
      });
      assert.equal(
        await vscode.commands.executeCommand(commandId('annotate-blame')),
        true,
      );
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(
          join(fixture.root, '.gitignore'),
        ),
        { viewColumn: vscode.ViewColumn.One, preview: false },
      );
      await expect
        .poll(() => vscode.window.visibleTextEditors.includes(first))
        .toBe(false);
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Two,
        preview: false,
      });
      const page = await workbench();
      const editor = page
        .locator('.monaco-editor:visible')
        .filter({ has: page.locator('.view-line', { hasText: /^first$/ }) })
        .last();

      // Native status events can invalidate a tooltip. Reacquire its current
      // payload rather than replaying a link from the retired snapshot.
      await expect(async () => {
        const hover = await nativeHover(editor, 'Fixture');
        const href = await hover
          .getByRole('link', { name: 'Open Commit in Git UI' })
          .getAttribute('data-href');

        assert.ok(href);
        const encoded = href.split('?')[1];

        assert.ok(encoded);
        const payload: unknown = JSON.parse(decodeURIComponent(encoded));

        assert.ok(Array.isArray(payload));
        assert.equal(payload.length, 1);
        const target: unknown = payload[0];

        assert.ok(
          target !== null &&
            typeof target === 'object' &&
            'documentUri' in target &&
            'sha' in target,
        );
        assert.equal(target.documentUri, document.uri.toString());
        assert.equal(target.sha, sha);
        assert.equal(
          await vscode.commands.executeCommand(
            commandId('open-blame-commit'),
            target,
          ),
          true,
        );
      }).toPass({ timeout: 15000 });
      const frame = await nativePanel(repository.rootUri.toString());

      await expect(
        frame.locator(`[data-commit-row][data-sha="${sha}"]`),
      ).toHaveAttribute('aria-selected', 'true');
      await expect(
        frame.locator('#details[aria-busy="false"] [data-path="sample.txt"]'),
      ).toHaveAttribute('aria-selected', 'true');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fixture.dispose();
    }
  });

  for (const ending of ['close', 'edit'])
    it(`a delayed hover link cannot navigate after ${ending}`, async function () {
      this.timeout(60000);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.action.closePanel');
      const fixture = await createFixture({ prefix: 'git-ui-blame-hover-' });
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(fixture.root),
      );

      assert.ok(repository);
      await repository.status();
      const editor = await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(
          join(fixture.root, 'sample.txt'),
        ),
        { preview: false },
      );
      const gitExtension = vscode.extensions.getExtension<{
        getAPI(version: 1): GitAPI;
      }>('vscode.git');

      assert.ok(gitExtension);
      const originalAPI = gitExtension.exports.getAPI;
      const originalCommit = repository.getCommit;
      let release = () => {};

      let validationStarted = () => {};

      let pending: Thenable<unknown> | undefined;
      const enteredValidation = new Promise<boolean>((resolve) => {
        validationStarted = () => resolve(true);
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      try {
        assert.equal(
          await vscode.commands.executeCommand(commandId('annotate-blame')),
          true,
        );
        const page = await workbench();
        const nativeEditor = page
          .locator('.monaco-editor:visible')
          .filter({ has: page.locator('.view-line', { hasText: 'first' }) })
          .last();

        // Populate hover details before holding the separate link validation.
        await nativeHover(nativeEditor, 'Fixture');
        repository.getCommit = async (ref) => {
          validationStarted();
          await held;

          return originalCommit.call(repository, ref);
        };

        gitExtension.exports.getAPI = (version) => {
          const api = originalAPI.call(gitExtension.exports, version);

          return new Proxy(api, {
            get: (target, property) => {
              if (property === 'repositories')
                return target.repositories.map((candidate) =>
                  candidate.rootUri.toString() === repository.rootUri.toString()
                    ? repository
                    : candidate,
                );
              const value: unknown = Reflect.get(target, property, target);

              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        };

        await expect(async () => {
          const hover = await nativeHover(nativeEditor, 'Fixture');

          assert.notEqual(editor.selection.active.character, 0);
          const href = await hover
            .getByRole('link', { name: 'Open Commit in Git UI' })
            .getAttribute('data-href');

          assert.ok(href);
          const encoded = href.split('?')[1];

          assert.ok(encoded);
          const payload: unknown = JSON.parse(decodeURIComponent(encoded));

          assert.ok(Array.isArray(payload));
          assert.equal(payload.length, 1);
          const target: unknown = payload[0];

          assert.ok(
            target && typeof target === 'object' && 'documentUri' in target,
          );
          assert.equal(target.documentUri, editor.document.uri.toString());
          pending = vscode.commands.executeCommand(
            commandId('open-blame-commit'),
            target,
          );
          const entered = await Promise.race([
            enteredValidation,
            pending.then((result) => {
              // A repository refresh can invalidate a tooltip before clicking it.
              assert.equal(result, false);

              return false;
            }),
          ]);

          assert.equal(entered, true);
        }).toPass({ timeout: 10000 });
        if (ending === 'close')
          await vscode.commands.executeCommand(
            commandId('close-blame'),
            editor.document.uri,
          );
        else
          assert.equal(
            await editor.edit((edit) =>
              edit.insert(new vscode.Position(0, 0), 'new\n'),
            ),
            true,
          );
        release();
        assert.equal(await pending, false);
      } finally {
        release();
        await pending;
        repository.getCommit = originalCommit;
        gitExtension.exports.getAPI = originalAPI;
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand(
          'workbench.action.revertAndCloseActiveEditor',
        );
        await fixture.dispose();
      }
    });
});
