import type { CommitRecord } from '../../shared/model';

interface CachedPage<T> {
  repositoryId: string;
  createdAt: number;
  snapshot: T;
  commits: CommitRecord[];
  nextOffset: number | null;
}

/** A bounded in-memory cache; cursors are always owned by the history reader. */
export class HistoryPageCache<T> {
  private readonly pages = new Map<string, CachedPage<T>>();

  constructor(private readonly clock: () => number) {}

  read(
    repositoryId: string,
    key: string,
    offset: number,
  ): CachedPage<T> | undefined {
    const identity = JSON.stringify([repositoryId, key, offset]);
    const page = this.pages.get(identity);

    if (!page) return undefined;
    this.pages.delete(identity);
    if (this.clock() - page.createdAt >= 60_000) return undefined;
    this.pages.set(identity, page);

    return { ...page, commits: structuredClone(page.commits) };
  }

  write(
    repositoryId: string,
    key: string,
    offset: number,
    snapshot: T,
    commits: CommitRecord[],
    nextOffset: number | null,
  ): void {
    const identity = JSON.stringify([repositoryId, key, offset]);

    this.pages.delete(identity);
    this.pages.set(identity, {
      repositoryId,
      snapshot,
      commits: structuredClone(commits),
      nextOffset,
      createdAt: this.clock(),
    });
    if (this.pages.size > 20)
      this.pages.delete(this.pages.keys().next().value!);
  }

  invalidate(repositoryId: string): void {
    for (const [key, page] of this.pages)
      if (page.repositoryId === repositoryId) this.pages.delete(key);
  }
}
