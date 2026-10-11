import assert from 'node:assert/strict';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { createBlameQueries } from '../../src/extension/git/blame';
import { GitCli } from '../../src/extension/git/cli';
import { BlameAnnotations } from '../../src/extension/native/blame-annotations';
import { annotationTexts, workbench } from '../fixtures/native-blame';
import { createFixture } from '../fixtures/repository';

async function setup() {
  const fixture = await createFixture({
    prefix: 'git-ui-native-blame-lifetime-',
  });
  const access = await getGitApi();
  const repository = await access.api.openRepository(
    vscode.Uri.file(fixture.root),
  );

  assert.ok(repository);
  await repository.status();
  const stableAccess = {
    ...access,
    repository: (id: string) =>
      id === repository.rootUri.toString() ? repository : access.repository(id),
  };
  const editor = await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(join(fixture.root, 'sample.txt')),
    { preview: false },
  );

  return {
    fixture,
    repository,
    editor,
    access: stableAccess,
    read: createBlameQueries(stableAccess, new GitCli(stableAccess)),
    async dispose() {
      if (!editor.document.isClosed) {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand(
          'workbench.action.revertAndCloseActiveEditor',
        );
      }

      await fixture.dispose();
    },
  };
}

describe('native Blame lifetime', () => {
  for (const ending of ['edit', 'close', 'dispose'])
    it(`an initial read cannot repaint an obsolete snapshot after ${ending}`, async () => {
      const f = await setup();
      let release = () => {};

      let started = false;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const annotations = new BlameAnnotations({
        getAccess: async () => f.access,
        readBlame: async (query, signal) => {
          if (!started) {
            started = true;
            await held;

            // Deliberately finish the real older read despite cancellation.
            return f.read(query);
          }

          return f.read(query, signal);
        },
        openCommit: async () => assert.fail('No click was made'),
      });
      const token = new vscode.CancellationTokenSource();
      const opening = annotations.annotate(f.editor);

      try {
        await expect.poll(() => started).toBe(true);
        if (ending === 'edit')
          assert.equal(
            await f.editor.edit((edit) =>
              edit.insert(new vscode.Position(0, 0), 'new\n'),
            ),
            true,
          );
        else if (ending === 'close') annotations.close(f.editor);
        else annotations.dispose();
        release();
        await opening;
        if (ending === 'edit') {
          const page = await workbench();

          await expect
            .poll(() => annotationTexts(page))
            .toContain('Not committed yet');
        } else {
          assert.equal(annotations.isEnabled(f.editor), false);
          assert.equal(
            await annotations.provideHover(
              f.editor.document,
              new vscode.Position(0, 0),
              token.token,
            ),
            null,
          );
        }
      } finally {
        release();
        await opening;
        token.dispose();
        annotations.dispose();
        await f.dispose();
      }
    });

  for (const ending of ['cancel', 'close'])
    it(`a pending hover failure is silent after ${ending}`, async () => {
      const f = await setup();
      const annotations = new BlameAnnotations({
        getAccess: async () => f.access,
        readBlame: f.read,
        openCommit: async () => assert.fail('No click was made'),
      });
      const token = new vscode.CancellationTokenSource();
      const original = f.repository.getCommit;
      let release = () => {};

      let started = false;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let hover: Promise<vscode.Hover | null> | null = null;

      try {
        await annotations.annotate(f.editor);
        f.repository.getCommit = async () => {
          started = true;
          await held;
          throw new Error('Superseded native hover');
        };

        hover = annotations.provideHover(
          f.editor.document,
          new vscode.Position(0, 0),
          token.token,
        );
        await expect.poll(() => started).toBe(true);
        if (ending === 'cancel') token.cancel();
        else annotations.close(f.editor);
        release();
        assert.equal(await hover, null);
      } finally {
        release();
        await hover;
        f.repository.getCommit = original;
        token.dispose();
        annotations.dispose();
        await f.dispose();
      }
    });
});
