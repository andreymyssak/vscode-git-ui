import assert from 'node:assert/strict';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { GitCli } from '../../src/extension/git/cli';
import { withRepositoryOperation } from '../../src/extension/git/repository-operations';
import { SourceControlService } from '../../src/extension/source-control/service';
import type { SourceControlState } from '../../src/shared/source-control';
import { createFixture } from '../fixtures/repository';

function emptyStorage(): vscode.Memento {
  function get<T>(key: string): T | undefined;
  function get<T>(key: string, fallback: T): T;
  function get<T>(_key: string, fallback?: T): T | undefined {
    return fallback;
  }

  return { get, keys: () => [], update: async () => {} };
}

function deferred() {
  let resolve = () => {};

  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

describe('Source Control automatic status updates', () => {
  it('reflects native edit, add, stage and remove events while an operation read is queued and keeps checked files', async () => {
    const fixture = await createFixture({
      prefix: 'git-ui automatic changes ',
    });
    const access = await getGitApi();
    const repository = await access.api.openRepository(
      vscode.Uri.file(fixture.root),
    );

    assert.ok(repository);
    const id = repository.rootUri.toString();
    const states: SourceControlState[] = [];
    const entered = deferred();
    const release = deferred();
    let service: SourceControlService | undefined;
    let queued: Promise<void> | undefined;
    let nativeEvents = 0;
    const subscription = repository.state.onDidChange(() => nativeEvents++);
    const published = () =>
      states.at(-1)?.repositories.find((repo) => repo.info.id === id);
    const files = () => {
      const changes = published()?.changes;

      return changes?.kind === 'ready' ? changes.items : [];
    };

    try {
      await writeFile(
        join(fixture.root, 'sample.txt'),
        'Selected before editing\n',
      );
      await repository.status();
      service = new SourceControlService(emptyStorage(), (state) =>
        states.push(state),
      );
      await service.refresh();
      await service.handle({ kind: 'ready', repositoryId: id, tab: 'commit' });
      await service.handle({
        kind: 'check',
        repositoryId: id,
        paths: ['sample.txt'],
        checked: true,
      });
      queued = withRepositoryOperation(new GitCli(access), id, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const before = nativeEvents;

      await writeFile(join(fixture.root, 'sample.txt'), 'Edited externally\n');
      await writeFile(
        join(fixture.root, 'external.txt'),
        'New external file\n',
      );
      // Native Source Control has observed the edit; Git UI must consume its event.
      await repository.status();
      assert.ok(nativeEvents > before);
      await expect
        .poll(
          () =>
            files()
              .map((file) => file.path)
              .sort(),
          { timeout: 5000 },
        )
        .toEqual(['external.txt', 'sample.txt']);
      assert.deepEqual(published()?.checked, ['sample.txt']);
      await repository.add([join(fixture.root, 'sample.txt')]);
      await repository.status();
      await expect
        .poll(
          () => files().find((file) => file.path === 'sample.txt')?.staged,
          { timeout: 5000 },
        )
        .toBe(true);
      assert.deepEqual(published()?.checked, ['sample.txt']);
      await unlink(join(fixture.root, 'external.txt'));
      await repository.status();
      await expect
        .poll(() => files().map((file) => file.path), { timeout: 5000 })
        .toEqual(['sample.txt']);
      assert.deepEqual(published()?.checked, ['sample.txt']);
    } finally {
      release.resolve();
      await queued;
      await service?.refresh();
      service?.dispose();
      subscription.dispose();
      await vscode.commands.executeCommand('git.close', repository.rootUri);
      await fixture.dispose();
    }
  }).timeout(30000);
});
