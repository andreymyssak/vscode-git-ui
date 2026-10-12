import type { Disposable } from 'vscode';

import type { GitApiAccess, GitRepository } from '../api';
import { GitCli } from '../cli';
import { withRepositoryOperation } from '../repository-operations';

export type BeforeWrite = () => void;

export function createRepositoryAccess(access: GitApiAccess) {
  let disposed = false;
  // API wrappers change on lookup; open/close events define repository lifetime.
  const lifetimes = new Map<string, symbol>();
  const listeners = new Set<() => void>();
  const subscriptions = new Set<Disposable>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  subscriptions.add(
    access.api.onDidCloseRepository((repository) => {
      lifetimes.delete(repository.rootUri.toString());
      notify();
    }),
  );
  subscriptions.add(
    access.api.onDidOpenRepository((repository) => {
      lifetimes.set(repository.rootUri.toString(), Symbol());
      notify();
    }),
  );

  function requireRepository(id: string) {
    if (disposed) throw new Error('The Source Control backend was disposed.');
    if (!access.repositories().some((info) => info.id === id))
      throw new Error('The repository closed. Refresh and select it again.');

    return access.repository(id);
  }

  function lease(id: string) {
    const repository = requireRepository(id);
    const root = repository.rootUri.toString();
    const lifetime = lifetimes.get(root) ?? Symbol();

    lifetimes.set(root, lifetime);
    const current = () => {
      const live = requireRepository(id);

      if (live.rootUri.toString() !== root || lifetimes.get(root) !== lifetime)
        throw new Error(
          'The repository changed. Refresh and review the selected files again.',
        );

      return live;
    };

    const cli = new GitCli({
      ...access,
      repository: (queryId) => {
        if (queryId !== id)
          throw new Error('The operation belongs to a different repository.');
        const live = current();

        return live;
      },
    });

    return {
      root: repository.rootUri,
      cli,
      current,
      async write<T>(
        beforeWrite: BeforeWrite,
        action: (cli: GitCli, repository: GitRepository) => Promise<T>,
      ): Promise<T> {
        return withRepositoryOperation(cli, id, async () => {
          const live = current();

          beforeWrite();

          return action(cli, live);
        });
      },
    };
  }

  return {
    lease,
    repositories(this: void) {
      if (disposed) throw new Error('The Source Control backend was disposed.');

      return access.repositories();
    },
    subscribeRepositories(this: void, changed: () => void): Disposable {
      if (disposed) throw new Error('The Source Control backend was disposed.');
      listeners.add(changed);

      return {
        dispose() {
          listeners.delete(changed);
        },
      };
    },
    subscribe(this: void, id: string, changed: () => void): Disposable {
      const subscription = requireRepository(id).state.onDidChange(changed);

      subscriptions.add(subscription);

      return {
        dispose() {
          subscriptions.delete(subscription);
          subscription.dispose();
        },
      };
    },
    dispose(this: void) {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      subscriptions.clear();
      listeners.clear();
      lifetimes.clear();
    },
  };
}

export type RepositoryLease = ReturnType<
  ReturnType<typeof createRepositoryAccess>['lease']
>;
