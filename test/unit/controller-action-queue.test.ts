import { expect, test, vi } from 'vitest';

import type { GitAction, OperationResult } from '../../src/shared/model';
import { a, b, fixture, page } from '../fixtures/controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

const history = {
  ...page([a, b]),
  refs: ['main', 'first', 'second'].map((name) => ({
    ...page([]).refs[0]!,
    id: `refs/heads/${name}`,
    name,
    tracking: { upstream: `refs/remotes/origin/${name}`, ahead: 0, behind: 2 },
  })),
};
const update = (name: string) => ({
  kind: 'action' as const,
  action: {
    kind: 'update-branch' as const,
    refId: `refs/heads/${name}`,
  },
});

test('another branch can queue while Update runs, without overlapping writes or repeating clicks', async (t) => {
  const f = fixture();
  const first = deferred<OperationResult>();
  const started = deferred<void>();
  const writes: GitAction[] = [];

  f.adapter.history = async () => history;
  f.adapter.operate = async (_id, action) => {
    writes.push(action);
    if (writes.length === 1) {
      started.resolve();

      return first.promise;
    }

    return { kind: 'success', backend: 'api' };
  };

  await f.controller.selectRepository('one');
  const pending = [f.controller.handle(f.request(update('first')))];

  t.onTestFinished(async () => {
    first.resolve({ kind: 'success', backend: 'api' });
    await Promise.allSettled(pending);
    f.controller.dispose();
  });
  await started.promise;
  pending.push(f.controller.handle(f.request(update('second'))));
  await f.controller.handle(f.request(update('second')));
  expect(writes).toHaveLength(1);
  await vi.waitFor(() =>
    expect(f.sent.map((message) => message.body)).toContainEqual({
      kind: 'operation-progress',
      operation: expect.objectContaining({
        queued: [
          {
            label: 'Updating second…',
            refIds: ['refs/heads/second'],
            section: 'branches',
          },
        ],
      }),
    }),
  );
  // Read-only navigation stays available while writes wait.
  await f.controller.handle(f.request({ kind: 'select-commit', sha: a }));
  expect(f.sent.some((message) => message.body.kind === 'details')).toBe(true);
  first.resolve({ kind: 'success', backend: 'api' });
  await Promise.all(pending);
  expect(
    writes.map((action) => action.kind === 'update-branch' && action.refId),
  ).toEqual(['refs/heads/first', 'refs/heads/second']);
  expect(f.sent.at(-1)?.body).toEqual({
    kind: 'operation-progress',
    operation: null,
  });
});

for (const change of ['target', 'repository', 'trust', 'dispose'] as const)
  test(`a queued branch action cannot run after its ${change} changes`, async (t) => {
    let trusted = true;
    const errors: string[] = [];
    const f = fixture(true, true, {
      trusted: () => trusted,
      reportActionError: async (message) => {
        errors.push(message);
      },
    });
    const first = deferred<OperationResult>();
    const started = deferred<void>();
    const writes: GitAction[] = [];
    let changed = false;

    f.adapter.history = async () =>
      changed && change === 'target'
        ? {
            ...history,
            refs: history.refs.map((ref) =>
              ref.name === 'second' ? { ...ref, sha: b } : ref,
            ),
          }
        : history;
    f.adapter.operate = async (_id, action) => {
      writes.push(action);
      started.resolve();

      return first.promise;
    };

    await f.controller.selectRepository('one');
    const pending = [f.controller.handle(f.request(update('first')))];

    t.onTestFinished(async () => {
      first.resolve({
        kind: 'error',
        backend: 'api',
        message: 'Fixture failure',
      });
      await Promise.allSettled(pending);
      f.controller.dispose();
    });
    await started.promise;
    const next =
      change === 'target'
        ? {
            kind: 'action' as const,
            action: {
              kind: 'delete-branch' as const,
              refId: 'refs/heads/second',
            },
          }
        : update('second');

    pending.push(f.controller.handle(f.request(next)));
    // A repeated request is deduplicated; queue feedback publishes independently.
    await f.controller.handle(f.request(next));
    await vi.waitFor(() =>
      expect(f.sent.map((message) => message.body)).toContainEqual({
        kind: 'operation-progress',
        operation: expect.objectContaining({
          queued: [
            {
              label:
                change === 'target' ? 'Deleting second…' : 'Updating second…',
              refIds: ['refs/heads/second'],
              section: 'branches',
            },
          ],
        }),
      }),
    );
    changed = true;
    if (change === 'repository') {
      await f.controller.selectRepository('two');
      await f.controller.selectRepository('one');
    }

    if (change === 'trust') trusted = false;
    if (change === 'dispose') f.controller.dispose();
    first.resolve({
      kind: 'error',
      backend: 'api',
      message: 'Fixture failure',
    });
    await Promise.all(pending);
    expect(writes).toHaveLength(1);
    if (change === 'target')
      expect(errors).toContain(
        'The target of the queued action changed. Select it and try again.',
      );
  });

for (const failure of ['result', 'exception'] as const)
  test(`a failed ${failure} clears progress and allows the next queued action to run`, async (t) => {
    const f = fixture();
    const first = deferred<OperationResult>();
    const started = deferred<void>();
    const writes: GitAction[] = [];

    f.adapter.history = async () => history;
    f.adapter.operate = async (_id, action) => {
      writes.push(action);
      if (writes.length === 1) {
        started.resolve();
        const result = await first.promise;

        if (failure === 'exception') throw new Error('Fixture exception');

        return result;
      }

      return { kind: 'success', backend: 'api' };
    };

    await f.controller.selectRepository('one');
    const pending = [f.controller.handle(f.request(update('first')))];

    t.onTestFinished(async () => {
      first.resolve({
        kind: 'error',
        backend: 'api',
        message: 'Fixture failure',
      });
      await Promise.allSettled(pending);
      f.controller.dispose();
    });
    await started.promise;
    pending.push(
      f.controller.handle(
        f.request({
          kind: 'action',
          action: { kind: 'delete-branch', refId: 'refs/heads/second' },
        }),
      ),
    );
    first.resolve({
      kind: 'error',
      backend: 'api',
      message: 'Fixture failure',
    });
    await Promise.all(pending);
    expect(writes.map((action) => action.kind)).toEqual([
      'update-branch',
      'delete-branch',
    ]);
    expect(f.sent.at(-1)?.body).toEqual({
      kind: 'operation-progress',
      operation: null,
    });
  });
