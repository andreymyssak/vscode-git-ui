import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import type { generateCommitMessage } from '../../src/extension/native/commit-message';
import { SourceControlService } from '../../src/extension/source-control/service';
import type {
  SourceControlRequest,
  SourceControlState,
} from '../../src/shared/source-control';
import { nativeBrowser } from '../fixtures/native-panel';
import type { Fixture } from '../fixtures/repository';
import { createFixture } from '../fixtures/repository';

type Generator = typeof generateCommitMessage;

type Transition =
  'message' | 'check' | 'tab' | 'repository' | 'cancel-generation';

function heldGenerator() {
  let resolve: ((message: string) => void) | undefined;
  const response = new Promise<string>((complete) => {
    resolve = complete;
  });
  const calls: {
    id: string;
    paths: string[];
    token: vscode.CancellationToken;
  }[] = [];
  const generate: Generator = (_cli, id, files, token) => {
    calls.push({ id, paths: files.map((file) => file.path), token });

    return response;
  };

  return {
    calls,
    generate,
    release(message: string) {
      assert.ok(resolve);
      resolve(message);
    },
  };
}

/** A fresh test Memento persists actual host writes through the public VS Code fs API. */
function emptyStorage() {
  const uri = vscode.Uri.file(
    join(tmpdir(), `git-ui-generation-${randomUUID()}.json`),
  );
  const entries = new Map<string, unknown>();
  let pending = Promise.resolve();

  function get<T>(key: string): T | undefined;
  function get<T>(key: string, defaultValue: T): T;
  function get<T>(_key: string, defaultValue?: T): T | undefined {
    return defaultValue;
  }

  const memento: vscode.Memento = {
    keys: () => [...entries.keys()],
    get,
    update: (key: string, value: unknown) => {
      if (value === undefined) entries.delete(key);
      else entries.set(key, value);
      const bytes = new TextEncoder().encode(
        JSON.stringify(Object.fromEntries(entries)),
      );

      pending = pending.then(() => vscode.workspace.fs.writeFile(uri, bytes));

      return pending;
    },
  };

  return {
    memento,
    async saved(): Promise<unknown> {
      await pending;

      return JSON.parse(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)),
      );
    },
    async dispose(): Promise<void> {
      await pending;
      await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
    },
  };
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            'The source-control request did not settle within five seconds.',
          ),
        ),
      5000,
    );
  });

  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function prepare(fixture: Fixture): Promise<void> {
  await writeFile(join(fixture.root, 'sample.txt'), 'retained saved changes\n');
  await fixture.runGit(['stash', 'push', '-m', 'Keep this stash']);
  await writeFile(join(fixture.root, 'sample.txt'), 'selected on disk\n');
  await writeFile(join(fixture.root, 'unchecked.txt'), 'unchecked staged\n');
  await fixture.runGit(['add', 'unchecked.txt']);
  await writeFile(join(fixture.root, 'unchecked.txt'), 'unchecked working\n');
}

async function gitState(fixture: Fixture) {
  const [head, index, status, stash, selected, unchecked] = await Promise.all([
    fixture.runGit(['rev-parse', 'HEAD']),
    fixture.runGit(['ls-files', '--stage', '-v', '-z']),
    fixture.runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    fixture.runGit(['stash', 'list', '--format=%H%x00%gs']),
    readFile(join(fixture.root, 'sample.txt'), 'utf8'),
    readFile(join(fixture.root, 'unchecked.txt'), 'utf8'),
  ]);

  return { head, index, status, stash, selected, unchecked };
}

async function setup(generator: Generator, additionalRepository = false) {
  const fixtures: Fixture[] = [];
  const storage = emptyStorage();
  let service: SourceControlService | undefined;
  const states: SourceControlState[] = [];
  const dispose = async (): Promise<void> => {
    service?.dispose();
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('notifications.hideList');
    for (const document of vscode.workspace.textDocuments)
      if (
        document.isDirty &&
        fixtures.some((fixture) =>
          document.uri.fsPath.startsWith(`${fixture.root}/`),
        )
      ) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand(
          'workbench.action.revertAndCloseActiveEditor',
        );
      }

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const fixture of fixtures) {
      await vscode.commands.executeCommand(
        'git.close',
        vscode.Uri.file(fixture.root),
      );
      await fixture.dispose();
    }

    await storage.dispose();
  };

  try {
    await vscode.commands.executeCommand('notifications.clearAll');
    const access = await getGitApi();

    for (let i = 0; i < (additionalRepository ? 2 : 1); i++) {
      const fixture = await createFixture({ prefix: 'git-ui generation ' });

      fixtures.push(fixture);
      await prepare(fixture);
      const repository = await access.api.openRepository(
        vscode.Uri.file(fixture.root),
      );

      assert.ok(repository);
      await repository.status();
    }

    service = new SourceControlService(
      storage.memento,
      (state) => states.push(state),
      generator,
    );
    await service.refresh();
    const first = fixtures[0];

    assert.ok(first);
    const id = vscode.Uri.file(first.root).toString();

    await expect
      .poll(() => service?.model.repositories.get(id)?.changes.kind, {
        timeout: 5000,
      })
      .toBe('ready');
    assert.equal(service.model.error, null);
    await service.handle({ kind: 'ready', repositoryId: id, tab: 'commit' });
    await service.handle({
      kind: 'check',
      repositoryId: id,
      paths: ['sample.txt'],
      checked: true,
    });
    await service.handle({
      kind: 'message',
      repositoryId: id,
      message: 'Original draft',
      editId: randomUUID(),
    });
    assert.equal(service.model.error, null);

    return { service, storage, fixtures, first, id, states, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function finish(
  context: Awaited<ReturnType<typeof setup>>,
  generator: ReturnType<typeof heldGenerator>,
  request: Promise<void> | undefined,
): Promise<void> {
  generator.release('Cleanup');
  try {
    await vscode.commands.executeCommand('notifications.clearAll');
    if (request) await bounded(request);
  } finally {
    await context.dispose();
  }
}

async function workbenchPage(): Promise<Page> {
  const browser = await nativeBrowser();
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes('/workbench/workbench.html'));

  assert.ok(page);

  return page;
}

function transitionRequest(
  kind: Transition,
  id: string,
  anotherId: string,
): SourceControlRequest {
  switch (kind) {
    case 'message':
      return {
        kind,
        repositoryId: id,
        message: 'Edited while generating',
        editId: randomUUID(),
      };
    case 'check':
      return { kind, repositoryId: id, paths: ['sample.txt'], checked: false };
    case 'tab':
      return { kind, tab: 'stash' };
    case 'repository':
      return { kind, repositoryId: anotherId };
    case 'cancel-generation':
      return { kind };
  }
}

describe('native Source Control generation lifecycle', () => {
  it('refuses Amend when the change list is unavailable and preserves hidden checks and Git state', async () => {
    const generator = heldGenerator();
    const context = await setup(generator.generate);

    try {
      await context.service.handle({
        kind: 'amend',
        repositoryId: context.id,
        enabled: true,
      });
      const before = await gitState(context.first);

      context.service.model.updateChanges(context.id, {
        kind: 'error',
        message: 'Changes unavailable',
      });
      await context.service.handle({
        kind: 'commit',
        repositoryId: context.id,
      });
      assert.match(
        context.service.model.error ?? '',
        /Wait for changes to load/,
      );
      assert.deepEqual(await gitState(context.first), before);
      assert.equal(
        context.service.model.requireRepository(context.id).commitMode.kind,
        'amend',
      );
      assert.deepEqual(
        context.service.model
          .requireRepository(context.id)
          .checked.selected()
          .map((file) => file.path),
        ['sample.txt'],
      );
    } finally {
      await context.dispose();
    }
  }).timeout(60000);

  it('publishes an editable generated draft for checked files without committing, staging, stashing or restoring', async () => {
    const generator = heldGenerator();
    const context = await setup(generator.generate);
    let request: Promise<void> | undefined;

    try {
      const before = await gitState(context.first);

      request = context.service.handle({
        kind: 'generate',
        repositoryId: context.id,
      });
      await expect
        .poll(() => generator.calls.length, { timeout: 5000 })
        .toBe(1);
      assert.equal(context.service.model.generating, true);
      assert.equal(generator.calls[0]?.id, context.id);
      assert.deepEqual(generator.calls[0]?.paths, ['sample.txt']);
      generator.release('Generated subject\n\nGenerated body.');
      await bounded(request);
      assert.equal(context.service.model.generating, false);
      assert.equal(
        context.service.model.draft(context.id),
        'Generated subject\n\nGenerated body.',
      );
      await context.service.handle({
        kind: 'message',
        repositoryId: context.id,
        message: 'Edited generated draft',
        editId: randomUUID(),
      });
      assert.equal(
        context.service.model.draft(context.id),
        'Edited generated draft',
      );
      assert.deepEqual(
        context.service.model
          .requireRepository(context.id)
          .checked.selected()
          .map((file) => file.path),
        ['sample.txt'],
      );
      assert.deepEqual(await context.storage.saved(), {
        'gitUI.sourceControlDrafts': [
          { repositoryId: context.id, message: 'Edited generated draft' },
        ],
      });
      assert.deepEqual(await gitState(context.first), before);
      assert.equal(context.service.model.error, null);
    } finally {
      await finish(context, generator, request);
    }
  });

  const transitions: Transition[] = [
    'message',
    'check',
    'tab',
    'repository',
    'cancel-generation',
  ];

  for (const transition of transitions)
    it(`discards a late generated draft after the ${transition} request`, async () => {
      const generator = heldGenerator();
      const context = await setup(
        generator.generate,
        transition === 'repository',
      );
      let request: Promise<void> | undefined;

      try {
        const before = await Promise.all(context.fixtures.map(gitState));
        const anotherId = context.fixtures[1]
          ? vscode.Uri.file(context.fixtures[1].root).toString()
          : context.id;

        if (transition === 'repository')
          await context.service.handle({
            kind: 'message',
            repositoryId: anotherId,
            message: 'Other repository draft',
            editId: randomUUID(),
          });
        request = context.service.handle({
          kind: 'generate',
          repositoryId: context.id,
        });
        await expect
          .poll(() => generator.calls.length, { timeout: 5000 })
          .toBe(1);
        await context.service.handle(
          transitionRequest(transition, context.id, anotherId),
        );
        assert.equal(generator.calls[0]?.token.isCancellationRequested, true);
        assert.equal(context.service.model.generating, false);
        generator.release('Late draft must be discarded');
        await bounded(request);
        assert.equal(
          context.service.model.draft(context.id),
          transition === 'message'
            ? 'Edited while generating'
            : 'Original draft',
        );
        assert.deepEqual(
          context.service.model
            .requireRepository(context.id)
            .checked.selected()
            .map((file) => file.path),
          transition === 'check' ? [] : ['sample.txt'],
        );
        if (transition === 'repository') {
          assert.equal(context.service.model.repositoryId, anotherId);
          assert.equal(
            context.service.model.draft(anotherId),
            'Other repository draft',
          );
        }

        if (transition === 'tab')
          assert.equal(context.service.model.tab, 'stash');
        assert.deepEqual(
          await Promise.all(context.fixtures.map(gitState)),
          before,
        );
        assert.equal(context.service.model.error, null);
      } finally {
        await finish(context, generator, request);
      }
    });

  it('a canceled Save dialog keeps dirty selected buffers, draft and checks and never calls the generator', async () => {
    const generator = heldGenerator();
    const context = await setup(generator.generate);
    const page = await workbenchPage();
    let request: Promise<void> | undefined;

    try {
      const before = await gitState(context.first);
      const uri = vscode.Uri.file(join(context.first.root, 'sample.txt'));
      const document = await vscode.workspace.openTextDocument(uri);

      await vscode.window.showTextDocument(document);
      const edit = new vscode.WorkspaceEdit();

      edit.insert(
        uri,
        new vscode.Position(0, 0),
        'unsaved selected contents\n',
      );
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(document.isDirty, true);
      request = context.service.handle({
        kind: 'generate',
        repositoryId: context.id,
      });
      await vscode.commands.executeCommand('notifications.showList');
      const notification = page
        .locator('.notification-list-item')
        .filter({ hasText: 'Save 1 unsaved affected file before continuing?' });

      await expect(notification).toBeVisible({ timeout: 5000 });
      await expect(
        notification.getByRole('button', {
          name: 'Save and Continue',
          exact: true,
        }),
      ).toBeVisible();
      await notification
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
      await bounded(request);
      assert.equal(generator.calls.length, 0);
      assert.equal(context.service.model.generating, false);
      assert.equal(document.isDirty, true);
      assert.equal(context.service.model.draft(context.id), 'Original draft');
      assert.deepEqual(
        context.service.model
          .requireRepository(context.id)
          .checked.selected()
          .map((file) => file.path),
        ['sample.txt'],
      );
      assert.deepEqual(await gitState(context.first), before);
      assert.equal(context.service.model.error, null);
    } finally {
      await finish(context, generator, request);
    }
  });

  it('disposal cancels generation and ignores a late draft without further state publication or Git writes', async () => {
    const generator = heldGenerator();
    const context = await setup(generator.generate);
    let request: Promise<void> | undefined;

    try {
      const before = await gitState(context.first);

      request = context.service.handle({
        kind: 'generate',
        repositoryId: context.id,
      });
      await expect
        .poll(() => generator.calls.length, { timeout: 5000 })
        .toBe(1);
      context.service.dispose();
      const published = context.states.length;

      assert.equal(generator.calls[0]?.token.isCancellationRequested, true);
      generator.release('Draft after disposal');
      await bounded(request);
      assert.equal(context.service.model.draft(context.id), 'Original draft');
      assert.equal(context.service.model.generating, false);
      assert.equal(context.states.length, published);
      assert.deepEqual(await gitState(context.first), before);
    } finally {
      await finish(context, generator, request);
    }
  });
});
