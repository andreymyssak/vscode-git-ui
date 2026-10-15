import type { Disposable } from 'vscode';

import type { GitApiAccess, GitRepository } from '../api';
import { GitCli } from '../cli';
import type { RepositoryEvent } from '../repository-event';
import { withRepositoryOperation } from '../repository-operations';

export type BeforeWrite = () => void;

export function createRepositoryAccess(access: GitApiAccess) {
  let disposed = false;
  // API wrappers change on lookup; open/close events define repository lifetime.
  const lifetimes = new Map<string, symbol>();
  const listeners = new Set<(event?: RepositoryEvent) => void>();
  const observers = new Set<{ id: string; bind(): void; dispose(): void }>();
  const subscriptions = new Set<Disposable>();
  const notify = (event: RepositoryEvent) => {
    for (const listener of listeners) listener(event);
  };

  subscriptions.add(
    access.api.onDidCloseRepository((repository) => {
      lifetimes.delete(repository.rootUri.toString());
      const id = repository.rootUri.toString();

      for (const observer of observers)
        if (observer.id === id) observer.dispose();
      notify({ kind: 'closed', repositoryId: id });
    }),
  );
  subscriptions.add(
    access.api.onDidOpenRepository((repository) => {
      lifetimes.set(repository.rootUri.toString(), Symbol());
      const id = repository.rootUri.toString();

      for (const observer of observers) if (observer.id === id) observer.bind();
      notify({ kind: 'opened', repositoryId: id });
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
        discovery?: { signal: AbortSignal | undefined },
      ): Promise<T> {
        // Only queue-key discovery is bounded for background inspection. Once
        // acquired, cleanup/writes keep the original CLI and await completion.
        const preflight = discovery ? cli.readOnly(discovery.signal) : cli;

        return withRepositoryOperation(
          preflight,
          id,
          async () => {
            const live = current();

            beforeWrite();

            return action(cli, live);
          },
          discovery?.signal,
        );
      },
    };
  }

  return {
    lease,
    repositories(this: void) {
      if (disposed) throw new Error('The Source Control backend was disposed.');

      return access.repositories();
    },
    subscribeRepositories(
      this: void,
      changed: (event?: RepositoryEvent) => void,
    ): Disposable {
      if (disposed) throw new Error('The Source Control backend was disposed.');
      listeners.add(changed);

      return {
        dispose() {
          listeners.delete(changed);
        },
      };
    },
    subscribe(this: void, id: string, changed: () => void): Disposable {
      let listener: Disposable | null = null;
      let generation: symbol | null = null;
      const observer = {
        id,
        bind() {
          listener?.dispose();
          const owner = Symbol();

          generation = owner;
          listener = requireRepository(id).state.onDidChange(() => {
            if (!disposed && generation === owner) changed();
          });
        },
        dispose() {
          generation = null;
          listener?.dispose();
          listener = null;
        },
      };

      observer.bind();
      observers.add(observer);

      return {
        dispose() {
          observers.delete(observer);
          observer.dispose();
        },
      };
    },
    dispose(this: void) {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      subscriptions.clear();
      for (const observer of observers) observer.dispose();
      observers.clear();
      listeners.clear();
      lifetimes.clear();
    },
  };
}

export type RepositoryLease = ReturnType<
  ReturnType<typeof createRepositoryAccess>['lease']
>;
