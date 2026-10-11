import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { createBlameQueries } from '../../src/extension/git/blame';
import { GitCli } from '../../src/extension/git/cli';
import { resolveBlameDocument } from '../../src/extension/native/blame-document';
import { nativeBlameCodec } from '../../src/extension/native/blame-encoding';
import { matchesBlameText } from '../../src/extension/native/blame-snapshot';
import { createFixture } from '../fixtures/repository';

describe('native Blame file encoding', () => {
  for (const specimen of [
    {
      name: 'Latin-1',
      encoding: 'iso88591',
      text: 'café\nASCII\n',
      bytes: Buffer.from('café\nASCII\n', 'latin1'),
      dirty: true,
    },
    {
      name: 'Windows-1251',
      encoding: 'windows1251',
      text: 'Привет\nASCII\n',
      bytes: Buffer.from('cff0e8e2e5f20a41534349490a', 'hex'),
      dirty: true,
    },
    {
      name: 'UTF-8 CRLF',
      encoding: 'utf8',
      text: 'café\r\n東京\r\n',
      bytes: Buffer.from('café\r\n東京\r\n'),
      dirty: true,
    },
    {
      name: 'UTF-8 BOM',
      encoding: 'utf8bom',
      text: 'café\n東京\n',
      bytes: Buffer.from('\uFEFFcafé\n東京\n'),
      dirty: false,
    },
  ])
    it(`${specimen.name} uses the actual document codec for working and historical text`, async () => {
      const f = await createFixture({
        prefix: 'git-ui-native-blame-encoding-',
      });

      try {
        const path = 'encoded.txt';
        const authorName = 'Олена 東京';
        const summary = 'Résumé 東京';

        await writeFile(join(f.root, path), specimen.bytes);
        await f.runGit(['add', '--', path]);
        await f.runGit([
          'commit',
          `--author=${authorName} <unicode@example.test>`,
          '-m',
          summary,
        ]);
        const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();
        const access = await getGitApi();
        const repository = await access.api.openRepository(
          vscode.Uri.file(f.root),
        );

        assert.ok(repository);
        await repository.status();
        const file = vscode.Uri.file(join(f.root, path));
        const working = await vscode.workspace.openTextDocument(file, {
          encoding: specimen.encoding,
        });

        assert.equal(working.encoding, specimen.encoding);
        assert.equal(working.getText(), specimen.text);
        assert.deepEqual(
          Buffer.from(
            await nativeBlameCodec.encode(working.getText(), working.encoding),
          ),
          specimen.bytes,
        );
        assert.equal(
          await nativeBlameCodec.decode(specimen.bytes, working.encoding),
          specimen.text,
        );
        const historical = await vscode.workspace.openTextDocument(
          access.api.toGitUri(file, sha),
          { encoding: specimen.encoding },
        );
        const index = await vscode.workspace.openTextDocument(
          access.api.toGitUri(file, ''),
          { encoding: specimen.encoding },
        );

        assert.equal(historical.encoding, specimen.encoding);
        assert.equal(historical.getText(), specimen.text);
        assert.equal(index.encoding, specimen.encoding);
        assert.equal(index.getText(), specimen.text);
        const read = createBlameQueries(
          access,
          new GitCli(access),
          nativeBlameCodec,
        );

        for (const document of [working, historical, index]) {
          const resolved = await resolveBlameDocument(access, document);

          assert.equal(resolved.kind, 'ready');
          if (resolved.kind !== 'ready')
            assert.fail('Missing encoded text snapshot');
          assert.equal(resolved.query.encoding, document.encoding);
          const result = await read(resolved.query);

          assert.equal(result.kind, 'blame');
          if (result.kind !== 'blame')
            assert.fail('Encoded text lost its history');
          assert.equal(
            matchesBlameText(result.lines, document.getText()),
            true,
          );
          assert.equal(result.lines.length, 2);
          for (const line of result.lines) {
            assert.equal(line.kind, 'committed');
            if (line.kind !== 'committed')
              assert.fail('Clean text lost attribution');
            assert.equal(line.sha, sha);
            assert.equal(line.authorName, authorName);
            assert.equal(line.authorEmail, 'unicode@example.test');
            assert.equal(line.summary, summary);
            assert.equal(line.originalPath, path);
          }
        }

        if (specimen.dirty) {
          const editor = await vscode.window.showTextDocument(working, {
            preview: false,
          });
          const newline = working.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

          assert.equal(
            await editor.edit((edit) =>
              edit.insert(new vscode.Position(0, 0), 'new' + newline),
            ),
            true,
          );
          const resolved = await resolveBlameDocument(access, working);

          if (resolved.kind !== 'ready')
            assert.fail('Missing dirty text snapshot');
          const result = await read(resolved.query);

          if (result.kind !== 'blame')
            assert.fail('Dirty text lost its history');
          assert.equal(result.lines[0]?.kind, 'uncommitted');
          const attributed = result.lines[1];

          assert.equal(attributed?.kind, 'committed');
          if (attributed?.kind !== 'committed')
            assert.fail('Insertion lost existing author');
          assert.equal(attributed.sha, sha);
          assert.equal(attributed.originalLine, 1);
          assert.equal(matchesBlameText(result.lines, working.getText()), true);
          await vscode.commands.executeCommand('workbench.action.files.revert');
        }

        assert.deepEqual(await readFile(file.fsPath), specimen.bytes);
        assert.equal(await f.runGit(['status', '--porcelain=v1']), '');
      } finally {
        await vscode.commands.executeCommand(
          'workbench.action.closeAllEditors',
        );
        await f.dispose();
      }
    });

  it('clearly rejects raw UTF-16 Git source that is not line-oriented text', async () => {
    const f = await createFixture({ prefix: 'git-ui-native-blame-binary-' });

    try {
      const path = 'utf16.txt';
      const text = 'café\nASCII\n';
      const bytes = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(text, 'utf16le'),
      ]);

      await writeFile(join(f.root, path), bytes);
      await f.runGit(['add', '--', path]);
      await f.runGit(['commit', '-m', 'Raw UTF-16 source']);
      const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(f.root),
      );

      assert.ok(repository);
      await repository.status();
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(join(f.root, path)),
        { encoding: 'utf16le' },
      );

      assert.equal(document.encoding, 'utf16le');
      assert.equal(document.getText(), text);
      const resolved = await resolveBlameDocument(access, document);

      if (resolved.kind !== 'ready')
        assert.fail('Missing decoded UTF-16 snapshot');
      const read = createBlameQueries(
        access,
        new GitCli(access),
        nativeBlameCodec,
      );

      await assert.rejects(
        read(resolved.query),
        /Git cannot annotate this file encoding as text/,
      );
      await assert.rejects(
        read({
          repositoryId: repository.rootUri.toString(),
          encoding: document.encoding,
          ignoreWhitespace: false,
          source: { kind: 'revision', path, sha },
        }),
        /Git cannot annotate this file encoding as text/,
      );
      assert.deepEqual(await readFile(join(f.root, path)), bytes);
      assert.equal(await f.runGit(['status', '--porcelain=v1']), '');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await f.dispose();
    }
  });

  it('keeps UTF-8 historical blobs but rejects transformed displayed and index contents', async () => {
    const f = await createFixture({
      prefix: 'git-ui-native-blame-transformed-',
    });

    try {
      const path = 'latin1.txt';
      const text = 'café\nASCII\n';
      const bytes = Buffer.from(text, 'latin1');

      await writeFile(
        join(f.root, '.gitattributes'),
        `${path} text working-tree-encoding=ISO-8859-1\n`,
      );
      await writeFile(join(f.root, path), bytes);
      await f.runGit(['add', '.']);
      await f.runGit(['commit', '-m', 'Transformed source']);
      const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(f.root),
      );

      assert.ok(repository);
      await repository.status();
      const file = vscode.Uri.file(join(f.root, path));
      const working = await vscode.workspace.openTextDocument(file, {
        encoding: 'iso88591',
      });
      const historical = await vscode.workspace.openTextDocument(
        access.api.toGitUri(file, sha),
      );
      const index = await vscode.workspace.openTextDocument(
        access.api.toGitUri(file, ''),
      );

      assert.equal(working.encoding, 'iso88591');
      assert.equal(working.getText(), text);
      for (const document of [historical, index]) {
        assert.equal(document.encoding, 'utf8');
        assert.equal(document.getText(), text);
      }

      const read = createBlameQueries(
        access,
        new GitCli(access),
        nativeBlameCodec,
      );

      for (const document of [working, index]) {
        const resolved = await resolveBlameDocument(access, document);

        if (resolved.kind !== 'ready')
          assert.fail('Missing transformed source snapshot');
        await assert.rejects(
          read(resolved.query),
          /Git blame does not support files transformed by working-tree-encoding/,
        );
      }

      const revision = await resolveBlameDocument(access, historical);

      if (revision.kind !== 'ready')
        assert.fail('Missing UTF-8 historical blob');
      const result = await read(revision.query);

      if (result.kind !== 'blame') assert.fail('UTF-8 blob lost its history');
      assert.equal(matchesBlameText(result.lines, text), true);
      assert.equal(result.lines[0]?.kind, 'committed');
      assert.equal(result.lines[0]?.sha, sha);
      const wrongEncoding = await vscode.workspace.openTextDocument(
        historical.uri,
        { encoding: 'iso88591' },
      );

      assert.equal(wrongEncoding.encoding, 'iso88591');
      assert.equal(wrongEncoding.getText(), 'cafÃ©\nASCII\n');
      const wrongRevision = await resolveBlameDocument(access, wrongEncoding);

      if (wrongRevision.kind !== 'ready')
        assert.fail('Missing non-UTF-8 historical query');
      await assert.rejects(read(wrongRevision.query), /working-tree-encoding/);

      assert.deepEqual(await readFile(file.fsPath), bytes);
      assert.equal(await f.runGit(['status', '--porcelain=v1']), '');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await f.dispose();
    }
  });
});
