import { expect, test } from 'vitest';

import type { PanelBody, Result } from '../../src/shared/messages';
import { initialView, reduceView } from '../../src/webview/app/model/state';
import { a, page } from '../fixtures/controller';

const repository = {
  id: 'one',
  rootUri: 'file:///one',
  label: 'One',
  branch: 'main',
  headSha: a,
};
const ready = { ...initialView(), repository, commits: page([a]).commits };

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
