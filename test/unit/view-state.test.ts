import { expect, test } from 'vitest';

import type { Scope } from '../../src/shared/model';
import { initialView, reduceView } from '../../src/webview/app/model/state';

test('revealing an older commit clears the previous diff comparison and file selection', () => {
  const sha = 'a'.repeat(40);
  const olderSha = 'b'.repeat(40);
  const commit = {
    sha,
    parents: [olderSha],
    message: 'Current',
    authorName: null,
    authorEmail: null,
    authorDate: null,
    commitDate: null,
  };
  const before = {
    ...initialView(),
    commits: [commit, { ...commit, sha: olderSha, parents: [] }],
    selectedSha: sha,
    selectedParentSha: olderSha,
    selectedFilePath: 'sample.txt',
    details: commit,
    files: { [olderSha]: [] },
  };
  const revealed = reduceView(before, {
    kind: 'host',
    message: {
      requestId: 'commit-jump',
      repositoryId: 'one',
      generation: 0,
      body: { kind: 'reveal', sha: olderSha },
    },
  });

  expect(revealed.selectedSha).toBe(olderSha);
  expect(revealed.selectedParentSha).toBeNull();
  expect(revealed.selectedFilePath).toBeNull();
  expect(revealed.details).toBeNull();
  expect(revealed.files).toEqual({});
});

test('comparison errors are parent-scoped, reject stale identities, and clear after success or selection change', () => {
  const sha = 'a'.repeat(40);
  const parent = 'b'.repeat(40);
  const commit = {
    sha,
    parents: [parent],
    message: 'Merge',
    authorName: null,
    authorEmail: null,
    authorDate: null,
    commitDate: null,
  };
  const state = {
    ...initialView(),
    selectedSha: sha,
    details: commit,
    commits: [commit, { ...commit, sha: 'c'.repeat(40) }],
    generation: 3,
  };
  const error = {
    kind: 'files-error' as const,
    sha,
    parentSha: parent,
    message: 'Parent unavailable.',
  };
  const result = (body: typeof error, generation = 3) => ({
    kind: 'host' as const,
    message: { requestId: 'comparison', repositoryId: 'one', generation, body },
  });
  const failed = reduceView(state, result(error));

  expect(failed.fileErrors[parent]).toBe('Parent unavailable.');
  expect(failed.error).toBe(null);
  expect(failed.files).toStrictEqual({});
  expect(reduceView(state, result(error, 2))).toBe(state);
  expect(reduceView(state, result({ ...error, sha: 'c'.repeat(40) }))).toBe(
    state,
  );
  expect(
    reduceView(state, result({ ...error, parentSha: 'd'.repeat(40) })),
  ).toBe(state);
  const loaded = reduceView(failed, {
    kind: 'host',
    message: {
      requestId: 'retry',
      repositoryId: 'one',
      generation: 3,
      body: { kind: 'files', sha, parentSha: parent, files: [] },
    },
  });

  expect(loaded.fileErrors[parent]).toBe(undefined);
  expect(loaded.files[parent]).toStrictEqual([]);
  expect(
    reduceView(failed, { kind: 'select-commit', sha: 'c'.repeat(40) })
      .fileErrors,
  ).toStrictEqual({});
});
test('single branch click only selects', () => {
  const before = initialView();
  const after = reduceView(before, {
    kind: 'select-ref',
    refId: 'refs/heads/topic',
  });

  expect(after.selectedRefId).toBe('refs/heads/topic');
  expect(after.scope).toStrictEqual(before.scope);
  expect(after.generation).toBe(before.generation);
});
test('HEAD scope follows checkout while explicit scope stays', () => {
  for (const scope of [
    { kind: 'head' },
    { kind: 'ref', refId: 'refs/heads/topic' },
  ] as Scope[]) {
    const state = { ...initialView(), scope };
    const after = reduceView(state, {
      kind: 'host',
      message: {
        requestId: 'refresh',
        repositoryId: 'one',
        generation: 1,
        body: {
          kind: 'loading',
          scope,
          text: '',
          repository: {
            id: 'one',
            label: 'One',
            rootUri: 'file:///one',
            headSha: 'b'.repeat(40),
            branch: 'new-branch',
          },
        },
      },
    });

    expect(after.scope).toStrictEqual(scope);
    expect(after.repository?.branch).toBe('new-branch');
  }
});
test('initial loading and root switching retain discovered repositories for restoration', () => {
  const repositories = ['one', 'two'].map((id) => ({
    id,
    label: id,
    rootUri: 'file:///' + id,
    headSha: null,
    branch: null,
  }));
  let state = reduceView(initialView(), {
    kind: 'host',
    message: {
      requestId: 'setup',
      repositoryId: '',
      generation: 0,
      body: { kind: 'setup', state: 'ready', message: '', repositories },
    },
  });

  for (const repository of repositories) {
    state = reduceView(state, {
      kind: 'host',
      message: {
        requestId: 'loading',
        repositoryId: repository.id,
        generation: state.generation + 1,
        body: {
          kind: 'loading',
          repository,
          scope: { kind: 'head' },
          text: '',
        },
      },
    });
    expect(state.repositories).toStrictEqual(repositories);
    expect(state.repository?.id).toBe(repository.id);
  }
});
