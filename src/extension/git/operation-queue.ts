import { diagnostics } from '../diagnostics';

export class OperationQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const accepted = performance.now();

    diagnostics.record('queue.accepted', { repositoryId: id });
    const next = previous
      .catch(() => {})
      .then(async () => {
        diagnostics.record('queue.started', {
          repositoryId: id,
          elapsedMs: performance.now() - accepted,
        });

        return action();
      });

    this.tails.set(id, next);
    try {
      return await next;
    } finally {
      diagnostics.record('queue.finished', {
        repositoryId: id,
        elapsedMs: performance.now() - accepted,
      });
      if (this.tails.get(id) === next) this.tails.delete(id);
    }
  }
}

export const repositoryOperations = new OperationQueue();
