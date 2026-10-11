import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { createBlameQueries } from '../../src/extension/git/blame';
import { GitCli } from '../../src/extension/git/cli';
import {
  blameFileUri,
  resolveBlameDocument,
} from '../../src/extension/native/blame-document';
import { createFixture } from '../fixtures/repository';

describe('Blame source documents', () => {
  it('resolves displayed contents and immutable historical paths on both diff sides', async () => {
    const f = await createFixture({ prefix: 'git-ui-blame-documents ü ' });

    try {
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(f.root),
      );

      assert.ok(repository);
      await repository.status();
      const first = (await f.runGit(['rev-parse', 'HEAD'])).trim();
      const file = vscode.Uri.file(join(f.root, 'sample.txt'));
      const working = await vscode.workspace.openTextDocument(file);
      const resolved = await resolveBlameDocument(access, working);

      assert.equal(resolved.kind, 'ready');
      if (resolved.kind !== 'ready') assert.fail('Missing working snapshot');
      assert.deepEqual(resolved.query.source, {
        kind: 'contents',
        path: 'sample.txt',
        headSha: first,
        contents: 'first\n',
      });
      await f.runGit(['mv', 'sample.txt', 'renamed ü.txt']);
      await f.runGit(['commit', '-m', 'Rename']);
      const second = (await f.runGit(['rev-parse', 'HEAD'])).trim();
      const old = await vscode.workspace.openTextDocument(
        access.api.toGitUri(file, first),
      );
      const renamed = await vscode.workspace.openTextDocument(
        access.api.toGitUri(
          vscode.Uri.file(join(f.root, 'renamed ü.txt')),
          second,
        ),
      );

      for (const [document, path, sha] of [
        [old, 'sample.txt', first],
        [renamed, 'renamed ü.txt', second],
      ] as const) {
        const result = await resolveBlameDocument(access, document);

        assert.equal(result.kind, 'ready');
        if (result.kind === 'ready')
          assert.deepEqual(result.query.source, {
            kind: 'revision',
            path,
            sha,
          });
      }

      await writeFile(join(f.root, 'renamed ü.txt'), 'staged\n');
      await f.runGit(['add', '--', 'renamed ü.txt']);
      await repository.status();
      const index = await vscode.workspace.openTextDocument(
        access.api.toGitUri(vscode.Uri.file(join(f.root, 'renamed ü.txt')), ''),
      );
      const staged = await resolveBlameDocument(access, index);

      assert.equal(staged.kind, 'ready');
      if (staged.kind === 'ready')
        assert.deepEqual(staged.query.source, {
          kind: 'contents',
          path: 'renamed ü.txt',
          headSha: second,
          contents: 'staged\n',
        });
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await f.dispose();
    }
  });

  it('attributes an index document before committing a staged rename', async () => {
    const f = await createFixture({ prefix: 'git-ui-blame-staged-rename ü ' });

    try {
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(f.root),
      );

      assert.ok(repository);
      const head = (await f.runGit(['rev-parse', 'HEAD'])).trim();
      const name =
        process.platform === 'win32' ? 'renamed ü.txt' : 'renamed\t" ü.txt';

      await f.runGit(['mv', 'sample.txt', name]);
      await writeFile(join(f.root, name), 'first\nworking only\n');
      await repository.status();
      const index = await vscode.workspace.openTextDocument(
        access.api.toGitUri(vscode.Uri.file(join(f.root, name)), ''),
      );
      const snapshot = await resolveBlameDocument(access, index);

      assert.equal(snapshot.kind, 'ready');
      if (snapshot.kind !== 'ready') assert.fail('Missing index snapshot');
      const result = await createBlameQueries(
        access,
        new GitCli(access),
      )(snapshot.query);

      assert.deepEqual(index.getText(), 'first\n');
      assert.equal(result.kind, 'blame');
      if (result.kind !== 'blame')
        assert.fail('Staged rename lost its history');
      assert.equal(result.lines.length, 1);
      assert.equal(result.lines[0]?.kind, 'committed');
      assert.equal(result.lines[0]?.sha, head);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await f.dispose();
    }
  });

  it('rejects unsupported, empty, binary and malformed documents', async () => {
    const f = await createFixture({ prefix: 'git-ui-blame-unsupported ' });

    try {
      const access = await getGitApi();

      await access.api.openRepository(vscode.Uri.file(f.root));
      const untitled = await vscode.workspace.openTextDocument({
        content: 'text',
      });

      assert.equal(
        (await resolveBlameDocument(access, untitled)).kind,
        'unsupported',
      );
      const uri = vscode.Uri.file(join(f.root, 'empty.txt'));

      await writeFile(uri.fsPath, '');
      const empty = await vscode.workspace.openTextDocument(uri);

      assert.equal(
        (await resolveBlameDocument(access, empty)).kind,
        'unsupported',
      );
      const binaryUri = vscode.Uri.file(join(f.root, 'binary.txt'));

      await writeFile(binaryUri.fsPath, 'beforeafter');
      const binary = await vscode.workspace.openTextDocument(binaryUri);
      const editor = await vscode.window.showTextDocument(binary);

      await editor.edit((builder) =>
        builder.insert(new vscode.Position(0, 6), '\0'),
      );
      assert.equal(
        (await resolveBlameDocument(access, binary)).kind,
        'unsupported',
      );
      await vscode.commands.executeCommand('workbench.action.files.revert');
      for (const query of [
        'not-json',
        '{"path":1,"ref":"HEAD"}',
        '{"path":"relative.txt","ref":"HEAD"}',
      ])
        assert.equal(blameFileUri(uri.with({ scheme: 'git', query })), null);
      assert.equal(blameFileUri(uri.with({ scheme: 'unsupported' })), null);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await f.dispose();
    }
  });
});
