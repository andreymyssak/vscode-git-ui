import type { GitApiAccess, GitCommit } from '../git/api';
import type { BlameLine, BlameQuery, BlameResult } from '../git/blame-model';

export class BlameReadCache {
  private readonly revisions = new Map<string, readonly BlameLine[]>();
  private readonly commits = new Map<string, Promise<GitCommit>>();
  private disposed = false;

  constructor(
    private readonly readBlame: (
      query: BlameQuery,
      signal?: AbortSignal,
    ) => Promise<BlameResult>,
  ) {}

  async read(query: BlameQuery, signal: AbortSignal): Promise<BlameResult> {
    const key =
      query.source.kind === 'revision'
        ? `${query.repositoryId}\0${query.source.sha}\0${query.source.path}\0${query.ignoreWhitespace}`
        : null;
    const cached = key ? this.revisions.get(key) : undefined;

    if (cached) return { kind: 'blame', lines: cached };
    const result = await this.readBlame(query, signal);

    if (
      !this.disposed &&
      !signal.aborted &&
      key &&
      result.kind === 'blame' &&
      result.lines.length <= 100_000
    ) {
      this.revisions.delete(key);
      this.revisions.set(key, result.lines);
      while (
        this.revisions.size > 8 ||
        [...this.revisions.values()].reduce(
          (sum, lines) => sum + lines.length,
          0,
        ) > 100_000
      ) {
        const oldest = this.revisions.keys().next().value;

        if (oldest === undefined) break;
        this.revisions.delete(oldest);
      }
    }

    return result;
  }

  commit(
    access: GitApiAccess,
    repositoryId: string,
    sha: string,
  ): Promise<GitCommit> {
    const key = `${repositoryId}\0${sha}`;
    const existing = this.commits.get(key);

    if (existing) return existing;
    const read = access
      .repository(repositoryId)
      .getCommit(sha)
      .catch((error: unknown) => {
        if (this.commits.get(key) === read) this.commits.delete(key);
        throw error;
      });

    this.commits.set(key, read);
    while (this.commits.size > 64) {
      const oldest = this.commits.keys().next().value;

      if (oldest === undefined) break;
      this.commits.delete(oldest);
    }

    return read;
  }

  invalidate(repositoryId?: string): void {
    for (const cache of [this.revisions, this.commits])
      for (const key of cache.keys())
        if (!repositoryId || key.startsWith(repositoryId + '\0'))
          cache.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }
}
