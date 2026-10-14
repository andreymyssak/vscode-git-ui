import assert from 'node:assert/strict';
import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { createSourceControlBackend } from '../../src/extension/git/source-control/index';
import { sourceControlCommandId } from '../../src/shared/extension-identity';
import { createFixture, type Fixture } from '../fixtures/repository';
import { sourceControlFrame } from '../fixtures/source-control-view';

async function open(fixture: Fixture) {
  const access = await getGitApi();
  const repository = await access.api.openRepository(
    vscode.Uri.file(fixture.root),
  );

  assert.ok(repository);
  await repository.status();
  await vscode.commands.executeCommand(
    sourceControlCommandId('refresh-changes'),
  );

  return sourceControlFrame();
}

async function finish(fixture: Fixture) {
  for (const document of vscode.workspace.textDocuments)
    if (document.uri.fsPath.startsWith(fixture.root) && document.isDirty)
      await document.save();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand(
    'git.close',
    vscode.Uri.file(fixture.root),
  );
  await fixture.dispose();
}

describe('Changes staging and whole-file inclusion', () => {
  it('protects unsaved files opened through folder aliases before Stage or Delete', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-action-alias-' });
    const backend = await createSourceControlBackend();
    const alias = fixture.root + '-alias';
    let document: vscode.TextDocument | undefined;

    try {
      await writeFile(join(fixture.root, 'sample.txt'), 'working\n');
      await symlink(
        fixture.root,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await open(fixture);
      const id = vscode.Uri.file(fixture.root).toString();
      const files = (await backend.workingChanges(id)).filter(
        (file) => file.path === 'sample.txt',
      );
      const stage = await backend.prepareFileAction({
        id,
        files,
        kind: 'stage-files',
      });
      const deletion = await backend.prepareFileAction({
        id,
        files,
        kind: 'delete-files',
      });

      document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(join(alias, 'sample.txt')),
      );
      const edit = new vscode.WorkspaceEdit();

      edit.insert(document.uri, new vscode.Position(0, 0), 'unsaved\n');
      assert.ok(await vscode.workspace.applyEdit(edit));
      assert.ok(document.isDirty);
      for (const action of [stage, deletion])
        await assert.rejects(action.write({ beforeWrite() {} }), /unsaved/i);
      for (const kind of ['stage-files', 'delete-files'] as const)
        await assert.rejects(
          backend.prepareFileAction({ id, files, kind }),
          /unsaved/i,
        );
      assert.equal(
        await readFile(join(fixture.root, 'sample.txt'), 'utf8'),
        'working\n',
      );
      assert.equal(await fixture.runGit(['show', ':sample.txt']), 'first\n');
      assert.equal(document.getText(), 'unsaved\nworking\n');
    } finally {
      if (document?.isDirty) await document.save();
      backend.dispose();
      await finish(fixture);
      await rm(alias, { force: true });
    }
  });

  it('rejects prepared Stage, Unstage and Delete after switching to another branch at the same commit', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-action-checkout-' });
    const backend = await createSourceControlBackend();

    try {
      await fixture.runGit(['branch', 'other']);
      await writeFile(join(fixture.root, 'sample.txt'), 'staged\n');
      await fixture.runGit(['add', 'sample.txt']);
      await writeFile(join(fixture.root, 'sample.txt'), 'working\n');
      await open(fixture);
      const id = vscode.Uri.file(fixture.root).toString();
      const files = (await backend.workingChanges(id)).filter(
        (file) => file.path === 'sample.txt',
      );
      const actions = await Promise.all(
        (['stage-files', 'unstage-files', 'delete-files'] as const).map(
          (kind) => backend.prepareFileAction({ id, files, kind }),
        ),
      );
      const index = await fixture.runGit(['ls-files', '--stage', '-z']);

      await fixture.runGit(['switch', 'other']);
      for (const action of actions)
        await assert.rejects(
          action.write({ beforeWrite() {} }),
          /checkout|branch|HEAD/i,
        );
      assert.equal(await fixture.runGit(['ls-files', '--stage', '-z']), index);
      assert.equal(
        await readFile(join(fixture.root, 'sample.txt'), 'utf8'),
        'working\n',
      );
    } finally {
      backend.dispose();
      await finish(fixture);
    }
  });

  it('links partial-file checkboxes without touching the index and commits the checked working contents', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-group-commit-' });

    try {
      await writeFile(join(fixture.root, 'keep.txt'), 'keep base\n');
      await fixture.runGit(['add', 'keep.txt']);
      await fixture.runGit(['commit', '-m', 'Keep base']);
      await writeFile(join(fixture.root, 'sample.txt'), 'staged\n');
      await writeFile(join(fixture.root, 'keep.txt'), 'keep staged\n');
      await fixture.runGit(['add', '.']);
      await writeFile(join(fixture.root, 'sample.txt'), 'working\n');
      const index = await fixture.runGit(['ls-files', '--stage', '-z']);
      const frame = await open(fixture);
      const staged = frame.getByRole('tree', {
        name: 'Staged Changes',
        exact: true,
      });
      const working = frame.getByRole('tree', { name: 'Changes', exact: true });

      await staged
        .getByRole('checkbox', { name: 'Include sample.txt', exact: true })
        .press('Space');
      await expect(
        working.getByRole('checkbox', {
          name: 'Include sample.txt',
          exact: true,
        }),
      ).toBeChecked();
      assert.equal(await fixture.runGit(['ls-files', '--stage', '-z']), index);
      await frame
        .getByRole('textbox', { name: 'Commit message' })
        .fill('Checked whole file');
      await frame.getByRole('button', { name: 'Commit', exact: true }).click();
      await expect
        .poll(() => fixture.runGit(['show', 'HEAD:sample.txt']), {
          timeout: 30000,
        })
        .toBe('working\n');
      assert.equal(
        await fixture.runGit(['show', 'HEAD:keep.txt']),
        'keep base\n',
      );
      assert.equal(
        await fixture.runGit(['show', ':keep.txt']),
        'keep staged\n',
      );
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
    } finally {
      await finish(fixture);
    }
  });

  it('uses native Stage/Unstage without altering inclusion, working text or unrelated staged files', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-stage-' });

    try {
      await writeFile(join(fixture.root, 'keep.txt'), 'keep staged\n');
      await fixture.runGit(['add', 'keep.txt']);
      await writeFile(join(fixture.root, 'sample.txt'), 'working\n');
      const frame = await open(fixture);
      const working = frame.getByRole('tree', { name: 'Changes', exact: true });
      const row = working.getByRole('treeitem', {
        name: 'sample.txt',
        exact: true,
      });

      await row.focus({ timeout: 5000 });
      await row.press('Shift+F10', { timeout: 5000 });
      await frame
        .page()
        .getByRole('menuitem', { name: 'Stage Changes', exact: true })
        .click({ delay: 150, timeout: 5000 });
      await expect
        .poll(() => fixture.runGit(['show', ':sample.txt']))
        .toBe('working\n');
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
      const staged = frame.getByRole('tree', {
        name: 'Staged Changes',
        exact: true,
      });
      const stagedRow = staged.getByRole('treeitem', {
        name: 'sample.txt',
        exact: true,
      });

      await expect(
        staged.getByRole('checkbox', {
          name: 'Include sample.txt',
          exact: true,
        }),
      ).not.toBeChecked();
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(join(fixture.root, 'sample.txt')),
      );
      const edit = new vscode.WorkspaceEdit();

      edit.insert(document.uri, new vscode.Position(0, 0), 'unsaved\n');
      assert.ok(await vscode.workspace.applyEdit(edit));
      await stagedRow.focus({ timeout: 5000 });
      await stagedRow.press('Shift+F10', { timeout: 5000 });
      await frame
        .page()
        .getByRole('menuitem', { name: 'Unstage Changes', exact: true })
        .click({ delay: 150, timeout: 5000 });
      await expect
        .poll(() =>
          fixture.runGit([
            'diff',
            '--cached',
            '--name-only',
            '--',
            'sample.txt',
          ]),
        )
        .toBe('');
      assert.equal(document.getText(), 'unsaved\nworking\n');
      assert.ok(document.isDirty);
      assert.equal(await readFile(document.uri.fsPath, 'utf8'), 'working\n');
      assert.equal(
        await fixture.runGit(['show', ':keep.txt']),
        'keep staged\n',
      );
    } finally {
      await finish(fixture);
    }
  });

  it('compares HEAD to index and index to working contents for partially staged files', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-stage-diff-' });
    const backend = await createSourceControlBackend();

    try {
      await writeFile(join(fixture.root, 'sample.txt'), 'staged\n');
      await fixture.runGit(['add', 'sample.txt']);
      await writeFile(join(fixture.root, 'sample.txt'), 'working\n');
      await open(fixture);
      const id = vscode.Uri.file(fixture.root).toString();
      const file = (await backend.workingChanges(id)).find(
        (file) => file.path === 'sample.txt',
      );

      assert.ok(file);
      const staged = await backend.workingComparison(id, file, true);
      const working = await backend.workingComparison(id, file, false);
      const text = async (uri: vscode.Uri) =>
        (await vscode.workspace.openTextDocument(uri)).getText();

      assert.equal(await text(staged.original), 'first\n');
      assert.equal(await text(staged.modified), 'staged\n');
      assert.equal(await text(working.original), 'staged\n');
      assert.equal(await text(working.modified), 'working\n');
    } finally {
      backend.dispose();
      await finish(fixture);
    }
  });

  it('stages deletions and unstages both sides of a rename while keeping the working rename', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-stage-rename-' });
    const backend = await createSourceControlBackend();

    try {
      await rename(
        join(fixture.root, 'sample.txt'),
        join(fixture.root, 'renamed.txt'),
      );
      await fixture.runGit(['add', '-A']);
      await open(fixture);
      const id = vscode.Uri.file(fixture.root).toString();
      const renameFiles = (await backend.workingChanges(id)).filter(
        (file) => file.path === 'renamed.txt',
      );
      const unstage = await backend.prepareFileAction({
        id,
        files: renameFiles,
        kind: 'unstage-files',
      });

      await unstage.write({ beforeWrite() {} });
      assert.equal(
        await fixture.runGit(['diff', '--cached', '--name-only']),
        '',
      );
      assert.equal(
        await readFile(join(fixture.root, 'renamed.txt'), 'utf8'),
        'first\n',
      );
      const deletion = (await backend.workingChanges(id)).filter(
        (file) => file.path === 'sample.txt',
      );
      const stage = await backend.prepareFileAction({
        id,
        files: deletion,
        kind: 'stage-files',
      });

      await stage.write({ beforeWrite() {} });
      assert.equal(
        await fixture.runGit(['diff', '--cached', '--name-status']),
        'D\tsample.txt\n',
      );
    } finally {
      backend.dispose();
      await finish(fixture);
    }
  });

  it('stages and unstages literal filenames without including similar names', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-stage-literal-' });
    const backend = await createSourceControlBackend();

    try {
      const pairs = [
        ['bracket[a].txt', 'bracketa.txt'],
        ...(process.platform === 'win32'
          ? []
          : [[':(exclude)sample.txt', 'sample.txt']]),
      ];

      for (const path of pairs.flat())
        await writeFile(join(fixture.root, path), 'base\n');
      await fixture.runGit(['add', '.']);
      await fixture.runGit(['commit', '-m', 'Literal base']);
      for (const path of pairs.flat())
        await writeFile(join(fixture.root, path), 'working\n');
      await open(fixture);
      const id = vscode.Uri.file(fixture.root).toString();

      for (const [path, similar] of pairs) {
        assert.ok(path && similar);
        const selected = async () =>
          (await backend.workingChanges(id)).filter(
            (file) => file.path === path,
          );
        const stage = await backend.prepareFileAction({
          id,
          files: await selected(),
          kind: 'stage-files',
        });

        await stage.write({ beforeWrite() {} });
        assert.equal(await fixture.runGit(['show', `:${path}`]), 'working\n');
        assert.equal(await fixture.runGit(['show', `:${similar}`]), 'base\n');
        await fixture.runGit(['--literal-pathspecs', 'add', '--', similar]);
        const unstage = await backend.prepareFileAction({
          id,
          files: await selected(),
          kind: 'unstage-files',
        });

        await unstage.write({ beforeWrite() {} });
        assert.equal(await fixture.runGit(['show', `:${path}`]), 'base\n');
        assert.equal(
          await fixture.runGit(['show', `:${similar}`]),
          'working\n',
        );
      }
    } finally {
      backend.dispose();
      await finish(fixture);
    }
  });

  it('refuses to unstage a deleted leaf when that would also unstage unchecked descendants', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-stage-overlap-' });
    const backend = await createSourceControlBackend();

    try {
      await unlink(join(fixture.root, 'sample.txt'));
      await mkdir(join(fixture.root, 'sample.txt'));
      await writeFile(
        join(fixture.root, 'sample.txt', 'child.txt'),
        'staged child\n',
      );
      await fixture.runGit(['add', '-A']);
      await open(fixture);
      const id = vscode.Uri.file(fixture.root).toString();
      const files = (await backend.workingChanges(id)).filter(
        (file) => file.path === 'sample.txt',
      );
      const index = await fixture.runGit(['ls-files', '--stage', '-z']);

      await assert.rejects(async () => {
        const action = await backend.prepareFileAction({
          id,
          files,
          kind: 'unstage-files',
        });

        await action.write({ beforeWrite() {} });
      }, /overlap/i);
      assert.equal(await fixture.runGit(['ls-files', '--stage', '-z']), index);
    } finally {
      backend.dispose();
      await finish(fixture);
    }
  });

  it('stages a recreated file from Changes when its old version is a staged deletion', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-stage-recreated-' });

    try {
      await unlink(join(fixture.root, 'sample.txt'));
      await fixture.runGit(['add', '-A']);
      await writeFile(join(fixture.root, 'sample.txt'), 'recreated\n');
      const frame = await open(fixture);
      const row = frame
        .getByRole('tree', { name: 'Changes', exact: true })
        .getByRole('treeitem', { name: 'sample.txt', exact: true });

      await expect(
        frame
          .getByRole('tree', { name: 'Staged Changes', exact: true })
          .getByRole('treeitem', { name: 'sample.txt', exact: true }),
      ).toHaveAttribute('data-status', 'deleted');
      await row.focus();
      await expect(
        row.getByRole('button', { name: 'Stage Changes', exact: true }),
      ).toBeVisible();
      await row
        .getByRole('button', { name: 'Stage Changes', exact: true })
        .click();
      await expect
        .poll(() => fixture.runGit(['show', ':sample.txt']).catch(() => null))
        .toBe('recreated\n');
      await expect(
        frame.getByRole('tab', { name: 'Commit', exact: true }),
      ).toBeEnabled();
    } finally {
      await finish(fixture);
    }
  });

  it('unstages a detected copy without changing separately staged edits to its source', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-stage-copy-' });
    const backend = await createSourceControlBackend();

    try {
      const base = Array.from(
        { length: 200 },
        (_, index) => `Original line ${index}\n`,
      ).join('');

      await writeFile(join(fixture.root, 'source.txt'), base);
      await fixture.runGit(['add', '.']);
      await fixture.runGit(['commit', '-m', 'Copy base']);
      await fixture.runGit(['config', 'status.renames', 'copies']);
      await writeFile(join(fixture.root, 'copy.txt'), base);
      await writeFile(
        join(fixture.root, 'source.txt'),
        base + 'source staged\n',
      );
      await fixture.runGit(['add', '.']);
      await open(fixture);
      const id = vscode.Uri.file(fixture.root).toString();
      const files = (await backend.workingChanges(id)).filter(
        (file) => file.path === 'copy.txt',
      );

      assert.equal(
        files[0]?.status,
        'C ',
        'This regression requires an actual copied Git entry',
      );
      const source = (await backend.workingChanges(id)).filter(
        (file) => file.path === 'source.txt',
      );
      const unstageSource = await backend.prepareFileAction({
        id,
        files: source,
        kind: 'unstage-files',
      });

      await unstageSource.write({ beforeWrite() {} });
      assert.equal(await fixture.runGit(['show', ':copy.txt']), base);
      assert.equal(await fixture.runGit(['show', ':source.txt']), base);
      await fixture.runGit(['add', 'source.txt']);
      const action = await backend.prepareFileAction({
        id,
        files,
        kind: 'unstage-files',
      });

      await action.write({ beforeWrite() {} });
      assert.equal(
        await fixture.runGit(['show', ':source.txt']),
        base + 'source staged\n',
      );
      assert.equal(
        await fixture.runGit(['diff', '--cached', '--name-only']),
        'source.txt\n',
      );
    } finally {
      backend.dispose();
      await finish(fixture);
    }
  });

  it('refuses a prepared stage or unstage after selected index contents change without a status change', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-stage-stale-' });
    const backend = await createSourceControlBackend();

    try {
      await writeFile(join(fixture.root, 'sample.txt'), 'staged one\n');
      await fixture.runGit(['add', 'sample.txt']);
      await writeFile(join(fixture.root, 'sample.txt'), 'working\n');
      await open(fixture);
      const id = vscode.Uri.file(fixture.root).toString();
      const files = (await backend.workingChanges(id)).filter(
        (file) => file.path === 'sample.txt',
      );
      const stage = await backend.prepareFileAction({
        id,
        files,
        kind: 'stage-files',
      });
      const unstage = await backend.prepareFileAction({
        id,
        files,
        kind: 'unstage-files',
      });

      await writeFile(join(fixture.root, 'sample.txt'), 'staged two\n');
      await fixture.runGit(['add', 'sample.txt']);
      await writeFile(join(fixture.root, 'sample.txt'), 'working\n');
      const index = await fixture.runGit(['ls-files', '--stage', '-z']);

      await assert.rejects(
        stage.write({ beforeWrite() {} }),
        /branch, HEAD or staged files changed/,
      );
      await assert.rejects(
        unstage.write({ beforeWrite() {} }),
        /branch, HEAD or staged files changed/,
      );
      assert.equal(await fixture.runGit(['ls-files', '--stage', '-z']), index);
    } finally {
      backend.dispose();
      await finish(fixture);
    }
  });

  it('stages an explicitly selected folder-to-file replacement without other changes', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-stage-folder-' });
    const backend = await createSourceControlBackend();

    try {
      await mkdir(join(fixture.root, 'old'));
      await writeFile(join(fixture.root, 'old', 'child.txt'), 'old child\n');
      await fixture.runGit(['add', '.']);
      await fixture.runGit(['commit', '-m', 'Folder base']);
      await rm(join(fixture.root, 'old'), { recursive: true });
      await writeFile(join(fixture.root, 'old'), 'replacement file\n');
      await open(fixture);
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(join(fixture.root, 'sample.txt')),
      );
      const edit = new vscode.WorkspaceEdit();

      edit.insert(
        document.uri,
        new vscode.Position(0, 0),
        'unrelated unsaved\n',
      );
      assert.ok(await vscode.workspace.applyEdit(edit));
      assert.ok(document.isDirty);
      const id = vscode.Uri.file(fixture.root).toString();
      const files = (await backend.workingChanges(id)).filter(
        (file) => file.path === 'old' || file.path.startsWith('old/'),
      );
      const action = await backend.prepareFileAction({
        id,
        files,
        kind: 'stage-files',
      });

      await action.write({ beforeWrite() {} });
      assert.equal(
        await fixture.runGit(['show', ':old']),
        'replacement file\n',
      );
      assert.equal(
        await fixture.runGit(['ls-files', '--', 'old/child.txt']),
        '',
      );
      assert.equal(await fixture.runGit(['show', ':sample.txt']), 'first\n');
      assert.equal(document.getText(), 'unrelated unsaved\nfirst\n');
      assert.ok(document.isDirty);
    } finally {
      backend.dispose();
      await finish(fixture);
    }
  });

  it('unstages new files before the initial commit through the native Git API', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-stage-unborn-' });
    const backend = await createSourceControlBackend();

    try {
      await fixture.runGit(['checkout', '--orphan', 'new-root']);
      await open(fixture);
      const id = vscode.Uri.file(fixture.root).toString();
      const files = (await backend.workingChanges(id)).filter(
        (file) => file.path === 'sample.txt',
      );
      const action = await backend.prepareFileAction({
        id,
        files,
        kind: 'unstage-files',
      });

      await action.write({ beforeWrite() {} });
      assert.equal(await fixture.runGit(['ls-files', '--', 'sample.txt']), '');
      assert.equal(
        await readFile(join(fixture.root, 'sample.txt'), 'utf8'),
        'first\n',
      );
      await unlink(join(fixture.root, 'sample.txt'));
    } finally {
      backend.dispose();
      await finish(fixture);
    }
  });
});
