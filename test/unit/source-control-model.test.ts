import { expect, test } from 'vitest';

import { SourceControlModel } from '../../src/extension/source-control/model';
import type { RepositoryInfo } from '../../src/shared/model';
import type {
  Stash,
  StashFile,
  WorkingFile,
} from '../../src/shared/source-control';

function repository(name: string): RepositoryInfo {
  return {
    id: `file:///workspace/${name}`,
    rootUri: `file:///workspace/${name}`,
    label: name,
    branch: 'main',
    headSha: 'a'.repeat(40),
  };
}

function working(path: string): WorkingFile {
  return {
    path,
    originalPath: path,
    status: ' M',
    staged: false,
    working: true,
    untracked: false,
  };
}

function fixture(saved: unknown = undefined) {
  let value = saved;
  const storage = {
    get: () => value,
    update: (_key: string, next: unknown) => {
      value = next;

      return Promise.resolve();
    },
  };
  const model = new SourceControlModel(storage);
  const first = repository('first');
  const second = repository('second');

  model.updateRepositories([first, second]);
  model.updateChanges(first.id, { kind: 'ready', items: [working('one.txt')] });
  model.updateChanges(second.id, {
    kind: 'ready',
    items: [working('two.txt')],
  });

  return { model, first, second, storage };
}

test('multiple repositories require an explicit selection and a single repository is selected automatically', () => {
  const { model, first, second } = fixture();

  expect(model.repositoryId).toBeNull();
  model.repositoryId = second.id;
  model.updateRepositories([first, second]);
  expect(model.repositoryId).toBe(second.id);
  model.updateRepositories([first]);
  expect(model.repositoryId).toBe(first.id);
});

test('changed-file membership belongs to the specified live repository', () => {
  const { model, first, second } = fixture();

  expect(model.workingFiles(first.id, ['one.txt'])).toEqual([
    working('one.txt'),
  ]);
  expect(() => model.workingFiles(second.id, ['one.txt'])).toThrow(
    'unavailable',
  );
  model.updateRepositories([second]);
  expect(() => model.workingFiles(first.id, ['one.txt'])).toThrow(
    'repository is unavailable',
  );
});

test('refresh retains surviving checks and excludes newly discovered paths', () => {
  const { model, first } = fixture();

  model.requireRepository(first.id).checked.setFile('one.txt', true);
  model.updateChanges(first.id, {
    kind: 'ready',
    items: [working('one.txt'), working('new.txt')],
  });
  expect(model.state().repositories[0]?.checked).toEqual(['one.txt']);
  model.updateChanges(first.id, { kind: 'ready', items: [working('new.txt')] });
  expect(model.state().repositories[0]?.checked).toEqual([]);
});

test('one repository draft serves both tabs and survives host recreation', () => {
  const { model, first, second, storage } = fixture();

  model.setDraft(first.id, 'Fix the first repository', 'first-edit-1');
  model.setDraft(second.id, 'Fix the second repository', 'second-edit-1');
  expect(storage.get()).toEqual([
    { repositoryId: first.id, message: 'Fix the first repository' },
    { repositoryId: second.id, message: 'Fix the second repository' },
  ]);
  model.tab = 'stash';
  expect(model.state().repositories[0]?.draft).toBe('Fix the first repository');
  const reopened = new SourceControlModel(storage);

  expect(reopened.draft(first.id)).toBe('Fix the first repository');
  expect(reopened.draft(second.id)).toBe('Fix the second repository');
  reopened.updateRepositories([first, second]);
  expect(reopened.state().repositories.map((repo) => repo.draftEditId)).toEqual(
    [null, null],
  );
  reopened.setDraft(first.id, '');
  const afterSuccess = new SourceControlModel(storage);

  expect(afterSuccess.draft(first.id)).toBe('');
  expect(afterSuccess.draft(second.id)).toBe('Fix the second repository');
});

test('Amend loads the last message and restores the new-commit draft when unchecked', () => {
  const { model, first } = fixture();

  model.setDraft(first.id, 'Next change');
  model.setAmend(first.id, {
    headSha: first.headSha!,
    message: 'Previous subject\n\nBody',
  });
  expect(model.draft(first.id)).toBe('Previous subject\n\nBody');
  expect(model.requireRepository(first.id).commitMode).toEqual({
    kind: 'amend',
    headSha: first.headSha,
  });
  model.setAmend(first.id, null);
  expect(model.draft(first.id)).toBe('Next change');
  expect(model.requireRepository(first.id).commitMode).toEqual({ kind: 'new' });
});

test('leaving Amend preserves edits to the loaded message', () => {
  const { model, first } = fixture();

  model.setDraft(first.id, 'Next change');
  model.setAmend(first.id, { headSha: first.headSha!, message: 'Previous' });
  model.setDraft(first.id, 'Edited message');
  model.setAmend(first.id, null);
  expect(model.draft(first.id)).toBe('Edited message');
  model.setAmend(first.id, { headSha: first.headSha!, message: 'Previous' });
  model.setAmend(first.id, null);
  expect(model.draft(first.id)).toBe('Edited message');
});

test('draft acknowledgments distinguish repeated text and host updates clear the ephemeral edit id', () => {
  const { model, first, second } = fixture();

  model.setDraft(first.id, 'a', 'first-edit-1');
  const firstAcknowledgment = model.state().repositories[0];

  model.setDraft(first.id, 'ab', 'first-edit-2');
  model.setDraft(first.id, 'a', 'first-edit-3');
  model.setDraft(second.id, 'Other draft', 'second-edit-1');
  expect(firstAcknowledgment?.draftEditId).toBe('first-edit-1');
  expect(model.state().repositories[0]).toMatchObject({
    draft: 'a',
    draftEditId: 'first-edit-3',
  });
  expect(model.state().repositories[1]).toMatchObject({
    draft: 'Other draft',
    draftEditId: 'second-edit-1',
  });
  model.setDraft(first.id, 'Generated draft');
  expect(model.state().repositories[0]?.draftEditId).toBeNull();
  model.setDraft(first.id, '', 'first-edit-4');
  expect(model.state().repositories[0]).toMatchObject({
    draft: '',
    draftEditId: 'first-edit-4',
  });
  model.setDraft(first.id, '');
  expect(model.state().repositories[0]).toMatchObject({
    draft: '',
    draftEditId: null,
  });
});

test('invalid persisted draft data cannot create host drafts', () => {
  const { model, first } = fixture([
    { repositoryId: null, message: 'bad' },
    { repositoryId: firstId(), message: 4 },
    null,
  ]);

  expect(model.draft(first.id)).toBe('');
});

function firstId(): string {
  return repository('first').id;
}

test('saved-file membership distinguishes snapshot versions and rejects missing stashes', () => {
  const { model, first, second } = fixture();
  const stash: Stash = {
    sha: 'b'.repeat(40),
    base: 'a'.repeat(40),
    selector: 'stash@{0}',
    message: 'Saved work',
    date: '2026-10-10T10:00:00+00:00',
  };
  const file: StashFile = {
    path: 'one.txt',
    originalPath: 'one.txt',
    snapshot: 'working',
    status: 'M',
    oldRef: stash.base,
    newRef: stash.sha,
    deleted: false,
  };

  model.updateStashes(first.id, { kind: 'ready', items: [stash] });
  model.requireStash(first.id, stash.sha).files = {
    kind: 'ready',
    items: [file],
  };
  expect(
    model.stashFiles(first.id, stash.sha, [
      { path: file.path, snapshot: 'working' },
    ]),
  ).toEqual([file]);
  expect(() =>
    model.stashFiles(first.id, stash.sha, [
      { path: file.path, snapshot: 'index' },
    ]),
  ).toThrow('unavailable');
  expect(() =>
    model.stashFiles(second.id, stash.sha, [
      { path: file.path, snapshot: 'working' },
    ]),
  ).toThrow('stash is unavailable');
  model.updateStashes(first.id, { kind: 'ready', items: [] });
  expect(() => model.requireStash(first.id, stash.sha)).toThrow(
    'stash is unavailable',
  );
});

test('reload of the same stash preserves loaded saved files without accepting foreign refs', () => {
  const { model, first } = fixture();
  const stash: Stash = {
    sha: 'b'.repeat(40),
    base: 'a'.repeat(40),
    selector: 'stash@{0}',
    message: 'Saved work',
    date: '2026-10-10T10:00:00+00:00',
  };

  model.updateStashes(first.id, { kind: 'ready', items: [stash] });
  model.requireStash(first.id, stash.sha).files = { kind: 'ready', items: [] };
  model.updateStashes(first.id, {
    kind: 'ready',
    items: [{ ...stash, selector: 'stash@{1}' }],
  });
  expect(model.requireStash(first.id, stash.sha).files).toEqual({
    kind: 'ready',
    items: [],
  });
  expect(() => model.requireStash(first.id, 'c'.repeat(40))).toThrow(
    'stash is unavailable',
  );
});
