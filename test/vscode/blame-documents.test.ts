import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { createBlameQueries } from '../../src/extension/git/blame';
import { GitCli } from '../../src/extension/git/cli';
import { BlameAnnotations } from '../../src/extension/native/blame-annotations';
import {
  blameFileUri,
  resolveBlameDocument,
} from '../../src/extension/native/blame-document';
import { createBlameHover } from '../../src/extension/native/blame-presentation';
import { commandId } from '../../src/shared/extension-identity';
import { createFixture } from '../fixtures/repository';

describe('native blame documents and sessions', () => {
  it('rejects unsupported, empty, binary and malformed documents', async () => {
    const f = await createFixture({ prefix: 'git-ui-blame-unsupported ' });
    let annotations: BlameAnnotations | undefined;

    try {
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(f.root),
      );

      assert.ok(repository);
      await repository.status();
      const untitled = await vscode.workspace.openTextDocument({
        content: 'text',
      });

      assert.equal(
        (await resolveBlameDocument(access, untitled)).kind,
        'unsupported',
      );
      const file = vscode.Uri.file(join(f.root, 'empty.txt'));

      await writeFile(file.fsPath, '');
      const empty = await vscode.workspace.openTextDocument(file);

      assert.equal(
        (await resolveBlameDocument(access, empty)).kind,
        'unsupported',
      );
      annotations = new BlameAnnotations({
        getAccess: async () => access,
        readBlame: createBlameQueries(access, new GitCli(access)),
      });
      const editor = await vscode.window.showTextDocument(empty);

      await assert.rejects(
        annotations.annotate(editor),
        /no lines to annotate/,
      );
      assert.equal(annotations.isEnabled(editor), false);
      const binary = vscode.Uri.file(join(f.root, 'binary.txt'));

      await writeFile(binary.fsPath, 'beforeafter');
      const binaryDocument = await vscode.workspace.openTextDocument(binary);
      const binaryEditor = await vscode.window.showTextDocument(binaryDocument);

      await binaryEditor.edit((builder) =>
        builder.insert(new vscode.Position(0, 6), '\0'),
      );
      assert.equal(
        (await resolveBlameDocument(access, binaryDocument)).kind,
        'unsupported',
      );
      await vscode.commands.executeCommand('workbench.action.files.revert');
      for (const query of [
        'not-json',
        '{"path":1,"ref":"HEAD"}',
        '{"path":"relative.txt","ref":"HEAD"}',
      ])
        assert.equal(blameFileUri(file.with({ scheme: 'git', query })), null);
      assert.equal(blameFileUri(file.with({ scheme: 'unsupported' })), null);
    } finally {
      annotations?.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await f.dispose();
    }
  });

  it('loads full messages only on hover and suppresses a cancelled hover', async () => {
    const f = await createFixture({ prefix: 'git-ui-blame-hover ' });
    let annotations: BlameAnnotations | undefined;

    try {
      await f.runGit([
        'commit',
        '--amend',
        '-m',
        'Visible subject\n\nFull body only in hover',
      ]);
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(f.root),
      );

      assert.ok(repository);
      await repository.status();
      let reads = 0;
      const counted = {
        ...access,
        repository: (id: string) =>
          new Proxy(access.repository(id), {
            get: (target, property) =>
              property === 'getCommit'
                ? (ref: string) => {
                    reads++;

                    return target.getCommit(ref);
                  }
                : Reflect.get(target, property, target),
          }),
      };
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(join(f.root, 'sample.txt')),
      );
      const editor = await vscode.window.showTextDocument(document);

      annotations = new BlameAnnotations({
        getAccess: async () => counted,
        readBlame: createBlameQueries(access, new GitCli(access)),
      });
      await annotations.annotate(editor);
      assert.equal(reads, 0);
      const token = new vscode.CancellationTokenSource();

      for (let index = 0; index < 2; index++) {
        const hover: vscode.Hover | null = await annotations.provideHover(
          document,
          new vscode.Position(0, 0),
          token.token,
        );

        assert.ok(hover?.contents[0] instanceof vscode.MarkdownString);
        assert.ok(
          hover.contents[0].value.includes(
            'Full&nbsp;body&nbsp;only&nbsp;in&nbsp;hover',
          ),
        );
      }

      assert.equal(reads, 1);
      token.cancel();
      assert.equal(
        await annotations.provideHover(
          document,
          new vscode.Position(0, 0),
          token.token,
        ),
        null,
      );
      token.dispose();
    } finally {
      annotations?.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await f.dispose();
    }
  });
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

  it('escapes author and full commit messages and trusts only our link command', () => {
    const sha = 'a'.repeat(40);
    const uri = vscode.Uri.file('/fixture/source.txt');
    const line = {
      kind: 'committed' as const,
      line: 1,
      text: 'first',
      originalLine: 1,
      originalPath: 'source.txt',
      sha,
      authorName: '[author](command:evil)',
      authorEmail: 'user@example.test',
      authorDate: '2023-11-14T22:13:20.000Z',
      summary: 'Short',
    };
    const hover = createBlameHover({
      line,
      documentUri: uri,
      commit: {
        hash: sha,
        parents: [],
        message: 'Full body\n\n[bad](command:evil)',
      },
    });

    assert.deepEqual(hover.isTrusted, {
      enabledCommands: [commandId('open-blame-commit')],
    });
    assert.ok(hover.value.includes('Full&nbsp;body'));
    assert.ok(!hover.value.includes('[bad](command:evil)'));
    assert.ok(!hover.value.includes('[author](command:evil)'));
    assert.ok(
      hover.value.includes(
        encodeURIComponent(
          JSON.stringify([{ documentUri: uri.toString(), sha }]),
        ),
      ),
    );
    const uncommitted = createBlameHover({
      line: { kind: 'uncommitted', line: 1, text: 'new' },
      documentUri: uri,
      commit: null,
    });

    assert.ok(!uncommitted.value.includes('command:'));
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

  it('refreshes unsaved snapshots, ignores superseded reads, and closes cleanly', async () => {
    const f = await createFixture({ prefix: 'git-ui-blame-lifecycle ü ' });
    let annotations: BlameAnnotations | undefined;

    try {
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(f.root),
      );

      assert.ok(repository);
      await repository.status();
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(join(f.root, 'sample.txt')),
      );
      const editor = await vscode.window.showTextDocument(document);
      const read = createBlameQueries(access, new GitCli(access));
      let release: (() => void) | undefined;
      let hold = true;
      let firstSignal: AbortSignal | undefined;

      annotations = new BlameAnnotations({
        getAccess: async () => access,
        readBlame: async (query, signal) => {
          if (hold) {
            hold = false;
            firstSignal = signal;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }

          return read(query, signal);
        },
      });
      const pending = annotations.annotate(editor);

      await expect.poll(() => Boolean(release)).toBe(true);
      await editor.edit((builder) =>
        builder.insert(new vscode.Position(0, 0), 'new\n'),
      );
      await expect.poll(() => firstSignal?.aborted).toBe(true);
      release?.();
      await pending;
      const token = new vscode.CancellationTokenSource();

      await expect
        .poll(
          async () =>
            (
              await annotations?.provideHover(
                document,
                new vscode.Position(1, 0),
                token.token,
              )
            )?.contents.length,
        )
        .toBe(1);
      const changed = await annotations.provideHover(
        document,
        new vscode.Position(0, 0),
        token.token,
      );

      assert.ok(changed);
      assert.ok(changed.contents[0] instanceof vscode.MarkdownString);
      assert.equal(changed.contents[0].value, 'Not&nbsp;committed&nbsp;yet');
      annotations.close(editor);
      assert.equal(annotations.isEnabled(editor), false);
      assert.equal(
        await annotations.provideHover(
          document,
          new vscode.Position(1, 0),
          token.token,
        ),
        null,
      );
      token.dispose();
      await vscode.commands.executeCommand('workbench.action.files.revert');
    } finally {
      annotations?.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await f.dispose();
    }
  });
});
