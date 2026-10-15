import { expect, test, vi } from 'vitest';

import type { GitApiAccess, GitRepository } from '../../src/extension/git/api';
import { createRepositoryObservations } from '../../src/extension/git/repository-observations';
import { createRepositoryAccess } from '../../src/extension/git/source-control/repository';
import { deferred } from '../fixtures/deferred';

vi.mock('vscode', () => ({}));

function fixture() {
  const open = new Set<(repository: GitRepository) => void>();
  const close = new Set<(repository: GitRepository) => void>();
  const event =
    (listeners: Set<(repository: GitRepository) => void>) =>
    (listener: (repository: GitRepository) => void) => {
      listeners.add(listener);

      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    };

  const repository = () => {
    const status = new Set<() => void>();
    const value = {
      rootUri: { toString: () => 'repo' },
      state: {
        HEAD: undefined,
        remotes: [],
        worktrees: [],
        onDidChange: (changed: () => void) => {
          status.add(changed);

          return {
            dispose: () => {
              status.delete(changed);
            },
          };
        },
      },
      getRefs: vi.fn(async () => []),
    };

    return { value, status };
  };

  const old = repository();
  let live = old;
  // Only this native boundary is stubbed; exercise the real subscription owners.
  const access = {
    api: {
      onDidOpenRepository: event(open),
      onDidCloseRepository: event(close),
    },
    repository: () => live.value,
    repositories: () => [{ id: 'repo' }],
  } as unknown as GitApiAccess;
  const replace = () => {
    for (const listener of close)
      listener(old.value as unknown as GitRepository);
    live = repository();
    for (const listener of open)
      listener(live.value as unknown as GitRepository);

    return live;
  };

  return { access, old, replace };
}

test('Log observation rebinds across same-turn close/open and suppresses old metadata', async () => {
  const { access, old, replace } = fixture();
  const changed = vi.fn();
  const invalidate = vi.fn();
  const observations = createRepositoryObservations({
    access,
    invalidate,
    onEvent() {},
  });
  const subscribed = observations.subscribe('repo', changed);

  await observations.settled('repo');
  const held = deferred<never[]>();

  old.value.getRefs.mockImplementation(() => held.promise);
  for (const listener of old.status) listener();
  await vi.waitFor(() => expect(old.value.getRefs).toHaveBeenCalledTimes(2));
  const replacement = replace();

  expect(old.status.size).toBe(0);
  await observations.settled('repo');
  expect(replacement.status.size).toBe(1);
  const count = changed.mock.calls.length;

  held.resolve([]);
  await held.promise;
  expect(changed).toHaveBeenCalledTimes(count);
  expect(invalidate).toHaveBeenCalledWith('repo');
  subscribed.dispose();
  observations.dispose();
  expect(replacement.status.size).toBe(0);
});

test('Source Control status subscription follows a replacement repository lifetime', () => {
  const { access, old, replace } = fixture();
  const owner = createRepositoryAccess(access);
  const changed = vi.fn();
  const subscription = owner.subscribe('repo', changed);
  const late = [...old.status][0];
  const replacement = replace();

  late?.();
  expect(changed).not.toHaveBeenCalled();

  expect(old.status.size).toBe(0);
  expect(replacement.status.size).toBe(1);
  for (const listener of replacement.status) listener();
  expect(changed).toHaveBeenCalledTimes(1);
  subscription.dispose();
  subscription.dispose();
  owner.dispose();
  expect(replacement.status.size).toBe(0);
});
