import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { GitCli } from '../../src/extension/git/cli';
import { toggleAmend } from '../../src/extension/source-control/message-tools';
import { SourceControlModel } from '../../src/extension/source-control/model';
import { sourceControlCommandId } from '../../src/shared/extension-identity';
import type { Fixture } from '../fixtures/repository';
import { createFixture } from '../fixtures/repository';
import { sourceControlFrame } from '../fixtures/source-control-view';

async function openRepository(fixture: Fixture) {
  const access = await getGitApi();
  const repo = await access.api.openRepository(vscode.Uri.file(fixture.root));

  assert.ok(repo);
  await repo.status();
  await vscode.commands.executeCommand(
    sourceControlCommandId('refresh-changes'),
  );

  return access;
}

async function closeRepository(fixture: Fixture): Promise<void> {
  await vscode.commands.executeCommand(
    'git.close',
    vscode.Uri.file(fixture.root),
  );
  await fixture.dispose();
  await vscode.commands.executeCommand(
    sourceControlCommandId('refresh-changes'),
  );
}

describe('Amend mode', () => {
  it('keeps file checkboxes enabled and preserves inclusion while toggling Amend', async () => {
    const fixture = await createFixture({ prefix: 'git-ui amend inclusion ' });

    try {
      await writeFile(join(fixture.root, 'sample.txt'), 'Changed file\n');
      await writeFile(join(fixture.root, 'new.txt'), 'New file\n');
      const head = await fixture.runGit(['rev-parse', 'HEAD']);
      const index = await fixture.runGit(['ls-files', '--stage', '-z']);

      await openRepository(fixture);
      const frame = await sourceControlFrame();
      const tree = frame.getByRole('tree', { name: 'Changes', exact: true });
      const checked = tree
        .getByRole('treeitem', { name: 'sample.txt', exact: true })
        .getByRole('checkbox');
      const unchecked = tree
        .getByRole('treeitem', { name: 'new.txt', exact: true })
        .getByRole('checkbox');
      const message = frame.getByRole('textbox', { name: 'Commit message' });
      const amend = frame.getByRole('checkbox', { name: 'Amend last commit' });

      await checked.press('Space');
      await expect(checked).toBeChecked();
      const summary = frame.getByRole('status', {
        name: 'Checked files summary',
      });

      await expect(summary.getByText('M 1', { exact: true })).toBeVisible();
      await message.fill('Keep my new-commit draft');
      await expect(amend).toBeEnabled();
      const monitor = await tree.evaluateHandle((element) => {
        const state = { disabledChanges: 0 };
        const observer = new MutationObserver((records) => {
          state.disabledChanges += records.length;
        });

        observer.observe(element, {
          attributes: true,
          subtree: true,
          attributeFilter: ['disabled', 'aria-disabled'],
        });

        return { state, observer };
      });

      try {
        await amend.press('Space');
        await expect(message).toHaveValue('Initial');
        await expect(amend).toBeChecked();
        await expect(amend).toBeEnabled();
        await amend.press('Space');
        await expect(message).toHaveValue('Keep my new-commit draft');
        await expect(amend).not.toBeChecked();
        await expect(checked).toBeEnabled();
        await expect(checked).toBeChecked();
        await expect(unchecked).toBeEnabled();
        await expect(unchecked).not.toBeChecked();
        await expect(summary.getByText('M 1', { exact: true })).toBeVisible();
        assert.equal(
          await monitor.evaluate(({ state }) => state.disabledChanges),
          0,
        );
        assert.equal(await fixture.runGit(['rev-parse', 'HEAD']), head);
        assert.equal(
          await fixture.runGit(['ls-files', '--stage', '-z']),
          index,
        );
      } finally {
        await monitor.evaluate(({ observer }) => observer.disconnect());
        await monitor.dispose();
      }
    } finally {
      await closeRepository(fixture);
    }
  }).timeout(90000);

  it('ignores a late last-commit message after the draft or commit mode changes', async () => {
    const fixture = await createFixture({ prefix: 'git-ui amend late read ' });

    try {
      const access = await openRepository(fixture);
      const id = vscode.Uri.file(fixture.root).toString();
      const info = access
        .repositories()
        .find((repository) => repository.id === id);

      assert.ok(info);
      const model = new SourceControlModel({
        get: () => undefined,
        update: async () => {},
      });

      model.updateRepositories([info]);
      const runtime = { access, cli: new GitCli(access) };

      model.setDraft(id, 'Original draft');
      const editing = toggleAmend({ runtime, model, id, enabled: true });

      model.setDraft(id, 'Newer edited draft');
      await editing;
      assert.equal(model.draft(id), 'Newer edited draft');
      assert.equal(model.requireRepository(id).commitMode.kind, 'new');
      const cancelled = toggleAmend({ runtime, model, id, enabled: true });

      model.setAmend(id, null);
      await cancelled;
      assert.equal(model.requireRepository(id).commitMode.kind, 'new');
      const writing = toggleAmend({ runtime, model, id, enabled: true });

      model.busy = true;
      await writing;
      assert.equal(model.requireRepository(id).commitMode.kind, 'new');
      assert.equal(model.draft(id), 'Newer edited draft');
    } finally {
      await closeRepository(fixture);
    }
  }).timeout(90000);
});
