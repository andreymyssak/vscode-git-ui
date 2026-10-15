import type { Disposable } from 'vscode';

/** Coalesce repository notifications while a captured Git write is completing. */
export class DeferredRepositoryRefresh {
  private readonly paused = new Map<
    string,
    { depth: number; pending: (() => void) | null }
  >();

  pause(repositoryId: string): Disposable {
    const entry = this.paused.get(repositoryId) ?? { depth: 0, pending: null };

    entry.depth++;
    this.paused.set(repositoryId, entry);
    let resumed = false;

    return {
      dispose: () => {
        if (resumed) return;
        resumed = true;
        if (--entry.depth !== 0) return;
        this.paused.delete(repositoryId);
        entry.pending?.();
      },
    };
  }

  defer(repositoryId: string, refresh: () => void): boolean {
    const entry = this.paused.get(repositoryId);

    if (!entry) return false;
    entry.pending = refresh;

    return true;
  }

  clear(repositoryId: string): void {
    const entry = this.paused.get(repositoryId);

    if (entry) entry.pending = null;
  }

  hasPending(repositoryId: string): boolean {
    return this.paused.get(repositoryId)?.pending != null;
  }
}
