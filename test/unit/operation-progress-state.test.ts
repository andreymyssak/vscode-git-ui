import { assert, expect, test } from 'vitest';

import { describeLogAction } from '../../src/extension/panel/operation-description';
import type { PanelBody, Result, UserAction } from '../../src/shared/messages';
import { initialView, reduceView } from '../../src/webview/app/model/state';
import { a, page } from '../fixtures/controller';

const repository = {
  id: 'one',
  rootUri: 'file:///one',
  label: 'One',
  branch: 'main',
  headSha: a,
};
const ready = {
  ...initialView(),
  repository,
  referencesReady: true,
  commits: page([a]).commits,
};

function progress(
  phase: 'running' | 'refreshing' | 'finished',
  requestId = 'update-one',
  repositoryId = 'one',
): Result<PanelBody> {
  return {
    requestId,
    repositoryId,
    generation: 0,
    body: {
      kind: 'operation-progress',
      operation:
        phase === 'finished'
          ? null
          : { label: 'Updating main…', refIds: ['refs/heads/main'], phase },
    },
  };
}

test('a pending Update preserves loaded history without starting a history query', () => {
  const state = reduceView(ready, {
    kind: 'host',
    message: progress('running'),
  });

  expect(state).toMatchObject({
    repository,
    commits: ready.commits,
    loading: false,
    operation: {
      requestId: 'update-one',
      label: 'Updating main…',
      refIds: ['refs/heads/main'],
      phase: 'running',
    },
  });
});

test('Update progress survives newer history generations and settles its own write', () => {
  const updating = reduceView(ready, {
    kind: 'host',
    message: progress('running'),
  });
  const browsing = reduceView(updating, {
    kind: 'apply-scope',
    scope: { kind: 'all' },
  });
  const refreshing = reduceView(browsing, {
    kind: 'host',
    message: progress('refreshing'),
  });

  expect(refreshing.operation?.phase).toBe('refreshing');
  const complete = reduceView(refreshing, {
    kind: 'host',
    message: progress('finished'),
  });

  expect(complete.operation).toBeNull();
  expect(complete.loading).toBe(true);
});

test('an earlier Update completion cannot clear a newer spinner', () => {
  const state = reduceView(ready, {
    kind: 'host',
    message: progress('running', 'new-update'),
  });

  expect(
    reduceView(state, { kind: 'host', message: progress('finished') }),
  ).toBe(state);
});

test('Update progress never crosses repositories', () => {
  const updating = reduceView(ready, {
    kind: 'host',
    message: progress('running'),
  });
  const other = reduceView(updating, {
    kind: 'host',
    message: {
      requestId: 'select-two',
      repositoryId: 'two',
      generation: 1,
      body: {
        kind: 'loading',
        repository: { ...repository, id: 'two', rootUri: 'file:///two' },
        scope: { kind: 'head' },
        text: '',
      },
    },
  });

  expect(other.operation).toBeNull();
  expect(
    reduceView(other, { kind: 'host', message: progress('running') }),
  ).toBe(other);
  expect(
    reduceView(other, { kind: 'host', message: progress('finished') }),
  ).toBe(other);
});

for (const action of [
  { kind: 'update-branch', refId: 'refs/heads/main' },
  { kind: 'checkout', refId: 'refs/heads/topic' },
  { kind: 'create-branch-checkout', refId: 'refs/heads/main' },
  { kind: 'rename-branch', refId: 'refs/heads/topic' },
  { kind: 'delete-branch', refId: 'refs/heads/topic' },
  { kind: 'delete-branches', refIds: ['refs/heads/topic', 'refs/heads/other'] },
  { kind: 'fetch-all' },
  { kind: 'merge-branch', refId: 'refs/heads/topic' },
  { kind: 'rebase-branch', refId: 'refs/heads/topic' },
  { kind: 'cherry-pick', sha: a },
  { kind: 'revert-files', fileIds: ['file'] },
  { kind: 'edit-commit-message', sha: a },
  { kind: 'drop-commits', shas: [a], activeSha: a },
  { kind: 'create-worktree', refId: 'refs/heads/topic' },
] satisfies UserAction[])
  test(`${action.kind} invalidates cached reference metadata when Git finishes`, () => {
    const description = describeLogAction(action);

    assert(description);
    const state = reduceView(ready, {
      kind: 'host',
      message: {
        ...progress('refreshing'),
        body: {
          kind: 'operation-progress',
          operation: { ...description, phase: 'refreshing' },
        },
      },
    });

    expect(state.referencesReady).toBe(false);
    expect(state.loading).toBe(false);
    expect(state.commits).toBe(ready.commits);
    const completed = reduceView(state, {
      kind: 'host',
      message: progress('finished'),
    });

    expect(completed.operation).toBeNull();
    expect(completed.referencesReady).toBe(false);
  });

for (const kind of ['references', 'history'] as const)
  test(`fresh ${kind} restores metadata without replayed progress hiding it again`, () => {
    const refreshing = reduceView(ready, {
      kind: 'host',
      message: progress('refreshing'),
    });
    const refreshed = reduceView(refreshing, {
      kind: 'host',
      message: {
        ...progress('refreshing'),
        body:
          kind === 'references'
            ? { kind, references: page([a]).refs }
            : {
                kind,
                repository,
                page: page([a]),
                append: false,
                scope: { kind: 'head' },
                text: '',
              },
      },
    });

    expect(refreshed.referencesReady).toBe(true);
    const replayed = reduceView(refreshed, {
      kind: 'host',
      message: progress('refreshing'),
    });

    expect(replayed.referencesReady).toBe(true);
    expect(
      reduceView(replayed, {
        kind: 'host',
        message: progress('refreshing', 'next-update'),
      }).referencesReady,
    ).toBe(false);
  });

test('an overlapping update and an earlier completion cannot restore stale metadata', () => {
  const first = reduceView(ready, {
    kind: 'host',
    message: progress('refreshing'),
  });
  const second = reduceView(first, {
    kind: 'host',
    message: progress('running', 'next-update'),
  });
  const settled = reduceView(second, {
    kind: 'host',
    message: progress('finished'),
  });

  expect(settled.referencesReady).toBe(false);
  expect(settled.operation?.requestId).toBe('next-update');
});

test('failed refreshes and obsolete responses cannot make cached metadata current', () => {
  let state = reduceView(ready, {
    kind: 'apply-scope',
    scope: { kind: 'all' },
  });

  for (const message of [
    progress('refreshing'),
    { ...progress('running'), body: { kind: 'references', references: [] } },
    {
      ...progress('running', 'other', 'two'),
      generation: 1,
      body: { kind: 'references', references: [] },
    },
    {
      ...progress('running'),
      generation: 1,
      body: { kind: 'error', message: 'References unavailable' },
    },
    progress('finished'),
  ] satisfies Result<PanelBody>[]) {
    state = reduceView(state, { kind: 'host', message });
    expect(state.referencesReady).toBe(false);
  }
});
