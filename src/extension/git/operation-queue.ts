export class OperationQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);

    this.tails.set(id, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(id) === next) this.tails.delete(id);
    }
  }
}

export const repositoryOperations = new OperationQueue();
