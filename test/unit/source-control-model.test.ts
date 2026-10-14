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
  const values = new Map<string, unknown>([
    ['gitUI.sourceControlDrafts', saved],
  ]);
  const storage = {
    get: (key = 'gitUI.sourceControlDrafts') => values.get(key),
    update: (key: string, next: unknown) => {
      values.set(key, next);

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

test('stash rewrites preserve view identity across refreshes, repository reopening and host recreation', async () => {
  const { model, first, second, storage } = fixture();
  const stash: Stash = {
    sha: 'b'.repeat(40),
    base: 'a'.repeat(40),
    selector: 'stash@{0}',
    message: 'Saved work',
    date: '2026-10-10T10:00:00+00:00',
  };

  model.updateStashes(first.id, { kind: 'ready', items: [stash] });
  const previous = model.requireStash(first.id, stash.sha);
  const renamed = { ...stash, sha: 'c'.repeat(40), message: 'Renamed' };

  await model.rememberStashRewrite(first.id, previous, renamed.sha);
  // A refresh started before the write can finish with the old object.
  model.updateStashes(first.id, { kind: 'ready', items: [stash] });
  model.updateStashes(first.id, { kind: 'ready', items: [renamed] });
  const current = model.requireStash(first.id, renamed.sha);

  expect(current.viewId).toBe(stash.sha);
  expect(current.files).toBeNull();
  const edited = { ...renamed, sha: 'd'.repeat(40) };

  await model.rememberStashRewrite(first.id, current, edited.sha);
  model.updateStashes(first.id, { kind: 'ready', items: [edited] });
  expect(model.requireStash(first.id, edited.sha).viewId).toBe(stash.sha);
  model.updateStashes(second.id, { kind: 'ready', items: [edited] });
  expect(model.requireStash(second.id, edited.sha).viewId).toBe(edited.sha);
  model.updateRepositories([second]);
  model.updateRepositories([first, second]);
  model.updateStashes(first.id, { kind: 'ready', items: [edited] });
  expect(model.requireStash(first.id, edited.sha).viewId).toBe(stash.sha);
  const reopened = new SourceControlModel(storage);

  reopened.updateRepositories([first]);
  reopened.updateStashes(first.id, { kind: 'ready', items: [edited] });
  expect(reopened.requireStash(first.id, edited.sha).viewId).toBe(stash.sha);
});

test('recovering original and intermediate Git stash objects keeps each card distinct', async () => {
  const { model, first, storage } = fixture();
  const original: Stash = {
    sha: 'b'.repeat(40),
    base: 'a'.repeat(40),
    selector: 'stash@{0}',
    message: 'Original',
    date: '2026-10-10T10:00:00+00:00',
  };
  const renamed = { ...original, sha: 'c'.repeat(40), message: 'Renamed' };
  const edited = { ...renamed, sha: 'd'.repeat(40) };

  model.updateStashes(first.id, { kind: 'ready', items: [original] });
  await model.rememberStashRewrite(
    first.id,
    model.requireStash(first.id, original.sha),
    renamed.sha,
  );
  model.updateStashes(first.id, { kind: 'ready', items: [renamed] });
  await model.rememberStashRewrite(
    first.id,
    model.requireStash(first.id, renamed.sha),
    edited.sha,
  );
  const recovered = [original, renamed, edited];

  model.updateStashes(first.id, { kind: 'ready', items: recovered });
  const ids = recovered.map(
    (stash) => model.requireStash(first.id, stash.sha).viewId,
  );

  expect(new Set(ids).size).toBe(3);
  expect(model.requireStash(first.id, edited.sha).viewId).toBe(original.sha);
  const reopened = new SourceControlModel(storage);

  reopened.updateRepositories([first]);
  reopened.updateStashes(first.id, { kind: 'ready', items: recovered });
  expect(
    recovered.map((stash) => reopened.requireStash(first.id, stash.sha).viewId),
  ).toEqual(ids);
});

test('invalid persisted stash identities and duplicate owners cannot merge cards', async () => {
  const { first, storage } = fixture();
  const stash: Stash = {
    sha: 'b'.repeat(40),
    base: 'a'.repeat(40),
    selector: 'stash@{0}',
    message: 'Saved work',
    date: '2026-10-10T10:00:00+00:00',
  };
  const other = { ...stash, sha: 'c'.repeat(40), selector: 'stash@{1}' };

  await storage.update('gitUI.stashViewIdentities', [
    null,
    { repositoryId: first.id, sha: stash.sha, viewId: '' },
    { repositoryId: first.id, sha: 'invalid', viewId: stash.sha },
    { repositoryId: null, sha: stash.sha, viewId: stash.sha },
    { repositoryId: first.id, sha: stash.sha, viewId: `${stash.sha}:1` },
    { repositoryId: first.id, sha: other.sha, viewId: `${stash.sha}:1` },
  ]);
  const reopened = new SourceControlModel(storage);

  reopened.updateRepositories([first]);
  reopened.updateStashes(first.id, { kind: 'ready', items: [stash, other] });
  expect(reopened.requireStash(first.id, stash.sha).viewId).toBe(
    `${stash.sha}:1`,
  );
  expect(reopened.requireStash(first.id, other.sha).viewId).toBe(other.sha);
});

test('a recovered card keeps its identity when another rewrite reuses an absent Git object', async () => {
  const { model, first, storage } = fixture();
  const original: Stash = {
    sha: 'b'.repeat(40),
    base: 'a'.repeat(40),
    selector: 'stash@{0}',
    message: 'Original',
    date: '2026-10-10T10:00:00+00:00',
  };
  const renamedSha = 'c'.repeat(40);
  const other = { ...original, sha: 'd'.repeat(40), selector: 'stash@{1}' };

  model.updateStashes(first.id, { kind: 'ready', items: [original] });
  await model.rememberStashRewrite(
    first.id,
    model.requireStash(first.id, original.sha),
    renamedSha,
  );
  // The renamed object was deleted; Git recovered the original alongside other work.
  model.updateStashes(first.id, { kind: 'ready', items: [original, other] });
  const recoveredId = model.requireStash(first.id, original.sha).viewId;

  await model.rememberStashRewrite(
    first.id,
    model.requireStash(first.id, other.sha),
    renamedSha,
  );
  const rewritten = { ...other, sha: renamedSha };

  model.updateStashes(first.id, {
    kind: 'ready',
    items: [original, rewritten],
  });
  expect(model.requireStash(first.id, original.sha).viewId).toBe(recoveredId);
  const reopened = new SourceControlModel(storage);

  reopened.updateRepositories([first]);
  reopened.updateStashes(first.id, {
    kind: 'ready',
    items: [original, rewritten],
  });
  expect(reopened.requireStash(first.id, original.sha).viewId).toBe(
    recoveredId,
  );
});

test('whole-file inclusion keeps all Git records for a recreated staged deletion, while row actions select their side', () => {
  const { model, first } = fixture();
  const deletion = {
    ...working('one.txt'),
    status: 'D ',
    staged: true,
    working: false,
  };
  const recreated = { ...working('one.txt'), status: '??', untracked: true };

  model.updateChanges(first.id, {
    kind: 'ready',
    items: [deletion, recreated],
  });
  model.requireRepository(first.id).checked.setFile('one.txt', true);
  expect(model.state().repositories[0]!.checked).toEqual(['one.txt']);
  expect(model.workingFiles(first.id, ['one.txt'])).toEqual([
    deletion,
    recreated,
  ]);
  expect(model.selectedFiles(first.id)).toEqual([deletion, recreated]);
  expect(model.workingFiles(first.id, ['one.txt'], 'index')).toEqual([
    deletion,
  ]);
  expect(model.workingFiles(first.id, ['one.txt'], 'working')).toEqual([
    recreated,
  ]);
});
