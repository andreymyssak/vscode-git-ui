import type { GitApiAccess, GitCommit } from '../git/api';
import type { BlameLine, BlameQuery, BlameResult } from '../git/blame-model';

interface PendingRead {
  repositoryId: string;
  abort: AbortController;
  promise: Promise<BlameResult>;
  consumers: number;
}

const abortError = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;

  return reason instanceof Error
    ? reason
    : new DOMException('Blame was canceled.', 'AbortError');
};

export class BlameReadCache {
  private readonly revisions = new Map<string, readonly BlameLine[]>();
  private readonly commits = new Map<string, Promise<GitCommit>>();
  private readonly pending = new Map<string, PendingRead>();
  private disposed = false;

  constructor(
    private readonly readBlame: (
      query: BlameQuery,
      signal?: AbortSignal,
    ) => Promise<BlameResult>,
  ) {}

  async read(query: BlameQuery, signal: AbortSignal): Promise<BlameResult> {
    signal.throwIfAborted();
    if (this.disposed)
      throw new DOMException('Blame was closed.', 'AbortError');
    const key = `${query.repositoryId}\0${JSON.stringify([query.source, query.ignoreWhitespace, query.encoding ?? 'utf8'])}`;
    const cached = this.revisions.get(key);

    if (cached) {
      this.revisions.delete(key);
      this.revisions.set(key, cached);

      return { kind: 'blame', lines: cached };
    }

    let pending = this.pending.get(key);

    if (!pending) {
      const abort = new AbortController();
      const promise = (async () => this.readBlame(query, abort.signal))()
        .then((result) => {
          if (
            this.pending.get(key)?.abort === abort &&
            !abort.signal.aborted &&
            query.source.kind === 'revision' &&
            result.kind === 'blame'
          )
            this.retain(key, result.lines);

          return result;
        })
        .finally(() => {
          if (this.pending.get(key)?.abort === abort) this.pending.delete(key);
        });

      pending = {
        repositoryId: query.repositoryId,
        abort,
        promise,
        consumers: 0,
      };
      this.pending.set(key, pending);
    }

    return this.consume(key, pending, signal);
  }

  private consume(
    key: string,
    pending: PendingRead,
    signal: AbortSignal,
  ): Promise<BlameResult> {
    pending.consumers++;

    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener('abort', cancel);
        pending.abort.signal.removeEventListener('abort', cancelProducer);
        if (--pending.consumers === 0 && this.pending.get(key) === pending) {
          this.pending.delete(key);
          pending.abort.abort();
        }

        return true;
      };

      const cancel = () => {
        if (release()) reject(abortError(signal));
      };

      const cancelProducer = () => {
        if (release()) reject(abortError(pending.abort.signal));
      };

      signal.addEventListener('abort', cancel, { once: true });
      pending.abort.signal.addEventListener('abort', cancelProducer, {
        once: true,
      });
      pending.promise.then(
        (result) => {
          if (release()) resolve(result);
        },
        (error: unknown) => {
          if (release())
            reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
      if (signal.aborted) cancel();
      else if (pending.abort.signal.aborted) cancelProducer();
    });
  }

  private retain(key: string, lines: readonly BlameLine[]): void {
    if (lines.length > 100_000) return;
    this.revisions.delete(key);
    this.revisions.set(key, lines);
    while (
      this.revisions.size > 8 ||
      [...this.revisions.values()].reduce(
        (sum, value) => sum + value.length,
        0,
      ) > 100_000
    ) {
      const oldest = this.revisions.keys().next().value;

      if (oldest === undefined) break;
      this.revisions.delete(oldest);
    }
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
    for (const [key, pending] of this.pending)
      if (!repositoryId || pending.repositoryId === repositoryId) {
        this.pending.delete(key);
        pending.abort.abort();
      }

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
