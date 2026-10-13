import type { Disposable } from 'vscode';

import type { GitApiAccess } from './api';
import { historyChangeFilter } from './history-events';

/** One native listener and coalesced metadata producer per observed repository. */
export function createRepositoryObservations({
  access,
  invalidate,
  onEvent,
}: {
  access: GitApiAccess;
  invalidate: (id: string) => void;
  onEvent: () => void;
}) {
  const repositories = new Map<
    string,
    {
      consumers: Set<{ changed(): void }>;
      observation: ReturnType<typeof historyChangeFilter>;
      listener: Disposable;
    }
  >();
  const subscriptions = new Set<Disposable>();
  let closed = false;

  return {
    settled(this: void, id: string): Promise<void> {
      return repositories.get(id)?.observation.settled() ?? Promise.resolve();
    },
    subscribe(this: void, id: string, changed: () => void): Disposable {
      if (closed) throw new Error('Repository observations are disposed.');
      let owner = repositories.get(id);

      if (!owner) {
        const repository = access.repository(id);
        const consumers = new Set<{ changed(): void }>();
        const observation = historyChangeFilter(repository, () => {
          invalidate(id);
          for (const consumer of consumers) consumer.changed();
        });
        const listener = repository.state.onDidChange(() => {
          onEvent();
          void observation.check();
        });

        owner = { consumers, observation, listener };
        repositories.set(id, owner);
      }

      const current = owner;
      const consumer = { changed };

      current.consumers.add(consumer);

      return {
        dispose() {
          if (!current.consumers.delete(consumer)) return;
          if (current.consumers.size) return;
          current.listener.dispose();
          current.observation.dispose();
          repositories.delete(id);
        },
      };
    },
    subscribeRepositories(this: void, changed: () => void): Disposable {
      if (closed) throw new Error('Repository observations are disposed.');
      let active = true;
      const refresh = () => {
        if (!active || closed) return;
        onEvent();
        changed();
      };

      const opened = access.api.onDidOpenRepository(refresh);
      const removed = access.api.onDidCloseRepository(refresh);
      const subscription = {
        dispose() {
          if (!active) return;
          active = false;
          subscriptions.delete(subscription);
          opened.dispose();
          removed.dispose();
        },
      };

      subscriptions.add(subscription);

      return subscription;
    },
    dispose(this: void) {
      if (closed) return;
      closed = true;
      for (const owner of repositories.values()) {
        owner.consumers.clear();
        owner.observation.dispose();
        owner.listener.dispose();
      }

      repositories.clear();
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}
