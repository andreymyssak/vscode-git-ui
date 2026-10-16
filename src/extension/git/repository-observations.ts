import type { Disposable } from 'vscode';

import type { GitApiAccess } from './api';
import { historyChangeFilter } from './history-events';
import type { HistoryShallow } from './history-shallow';
import type { RepositoryEvent } from './repository-event';

/** One native listener and coalesced metadata producer per observed repository. */
export function createRepositoryObservations({
  access,
  invalidate,
  onEvent,
  shallow,
  watchShallow,
}: {
  access: GitApiAccess;
  invalidate: (id: string) => void;
  onEvent: () => void;
  shallow?: HistoryShallow;
  watchShallow?: (id: string, changed: () => void) => Disposable;
}) {
  const repositories = new Map<
    string,
    {
      consumers: Set<{ changed(): void }>;
      settled(): Promise<void>;
      dispose(): void;
      bind(): void;
    }
  >();
  let closed = false;
  const repositoryConsumers = new Set<(event?: RepositoryEvent) => void>();
  const retire = (id: string) => {
    const owner = repositories.get(id);

    if (!owner) return;
    owner.dispose();
  };

  const lifecycle = (event: RepositoryEvent) => {
    if (closed) return;
    retire(event.repositoryId);
    invalidate(event.repositoryId);
    if (event.kind === 'opened') repositories.get(event.repositoryId)?.bind();
    onEvent();
    for (const changed of repositoryConsumers) changed(event);
  };

  const opened = access.api.onDidOpenRepository((repository) =>
    lifecycle({
      kind: 'opened',
      repositoryId: repository.rootUri.toString(),
    }),
  );
  const removed = access.api.onDidCloseRepository((repository) =>
    lifecycle({
      kind: 'closed',
      repositoryId: repository.rootUri.toString(),
    }),
  );

  return {
    settled(this: void, id: string): Promise<void> {
      return repositories.get(id)?.settled() ?? Promise.resolve();
    },
    subscribe(this: void, id: string, changed: () => void): Disposable {
      if (closed) throw new Error('Repository observations are disposed.');
      let owner = repositories.get(id);

      if (!owner) {
        const consumers = new Set<{ changed(): void }>();
        let binding: {
          observation: ReturnType<typeof historyChangeFilter>;
          listener: Disposable;
          shallow: Disposable | undefined;
        } | null = null;
        const dispose = () => {
          binding?.listener.dispose();
          binding?.shallow?.dispose();
          binding?.observation.dispose();
          binding = null;
        };

        owner = {
          consumers,
          dispose,
          settled: () => binding?.observation.settled() ?? Promise.resolve(),
          bind() {
            dispose();
            const repository = access.repository(id);
            const observation = historyChangeFilter(
              repository,
              () => {
                invalidate(id);
                for (const consumer of consumers) consumer.changed();
              },
              shallow ? (signal) => shallow.identity(id, signal) : undefined,
            );
            const listener = repository.state.onDidChange(() => {
              if (binding?.observation !== observation) return;
              onEvent();
              void observation.check();
            });

            binding = {
              observation,
              listener,
              shallow: watchShallow?.(id, () => {
                if (binding?.observation === observation)
                  void observation.check();
              }),
            };
          },
        };
        owner.bind();
        repositories.set(id, owner);
      }

      const current = owner;
      const consumer = { changed };

      current.consumers.add(consumer);

      return {
        dispose() {
          if (!current.consumers.delete(consumer)) return;
          if (current.consumers.size) return;
          current.dispose();
          if (repositories.get(id) === current) repositories.delete(id);
        },
      };
    },
    subscribeRepositories(
      this: void,
      changed: (event?: RepositoryEvent) => void,
    ): Disposable {
      if (closed) throw new Error('Repository observations are disposed.');
      repositoryConsumers.add(changed);

      return {
        dispose() {
          repositoryConsumers.delete(changed);
        },
      };
    },
    dispose(this: void) {
      if (closed) return;
      closed = true;
      for (const owner of repositories.values()) {
        owner.consumers.clear();
        owner.dispose();
      }

      repositories.clear();
      opened.dispose();
      removed.dispose();
      repositoryConsumers.clear();
    },
  };
}
