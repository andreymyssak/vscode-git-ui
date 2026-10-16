import { randomUUID } from 'node:crypto';
import { relative, sep } from 'node:path';

import type { FileChange } from '../../shared/model';
import {
  readCancellationError,
  readWithCancellation,
} from '../read-cancellation';
import type { GitApiAccess, GitChange, GitRepository } from './api';
import { backgroundRead } from './background-read';
import type { GitCli } from './cli';
import { readObjectParents } from './parents';

export class ComparisonCache<T> {
  private readonly values = new Map<string, T>();
  get(key: string): T | undefined {
    const value = this.values.get(key);

    if (value !== undefined) {
      this.values.delete(key);
      this.values.set(key, value);
    }

    return value;
  }

  set(key: string, value: T): void {
    this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size > 100) {
      const oldest = this.values.keys().next().value;

      if (oldest !== undefined) this.values.delete(oldest);
    }
  }

  deleteMatching(prefix: string): void {
    for (const key of this.values.keys())
      if (key.startsWith(prefix)) this.values.delete(key);
  }

  get size(): number {
    return this.values.size;
  }
}

function checkedPath(path: string): string {
  if (
    !path ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '..' || part === '.') ||
    path.includes('\0')
  )
    throw new Error('Git returned a path outside the repository.');

  return path;
}

function change(
  status: FileChange['status'],
  oldPath: string | null,
  newPath: string | null,
): FileChange {
  return {
    id: randomUUID(),
    status,
    oldPath: oldPath === null ? null : checkedPath(oldPath),
    newPath: newPath === null ? null : checkedPath(newPath),
  };
}

export function fromApiChange(item: GitChange, root: string): FileChange {
  const path = (value: string) => relative(root, value).split(sep).join('/');
  const original = path(item.originalUri.fsPath);
  const current = path(item.uri.fsPath);

  if (item.status === 1 || item.status === 4 || item.status === 7)
    return change('added', null, current);
  if (item.status === 2 || item.status === 6)
    return change('deleted', original, null);
  if (item.status === 3)
    return change(
      'renamed',
      original,
      path((item.renameUri ?? item.uri).fsPath),
    );

  return change('modified', original, current);
}

export function rootChanges(output: string): FileChange[] {
  const fields = output.split('\0');
  const changes: FileChange[] = [];

  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++] ?? '';
    const first = fields[i++];

    if (!first) throw new Error('Incomplete Git change record.');
    if (status.startsWith('R')) {
      const second = fields[i++];

      if (!second) throw new Error('Incomplete rename.');
      changes.push(change('renamed', first, second));
    } else if (status.startsWith('C')) {
      const second = fields[i++];

      if (!second) throw new Error('Incomplete copy.');
      changes.push(change('added', null, second));
    } else
      changes.push(
        change(
          status === 'D' ? 'deleted' : status === 'A' ? 'added' : 'modified',
          status === 'A' ? null : first,
          status === 'D' ? null : first,
        ),
      );
  }

  return changes;
}

export interface ChangeQueries {
  (
    id: string,
    sha: string,
    parent: string | null,
    signal?: AbortSignal,
  ): Promise<FileChange[]>;
  invalidate(this: void, id: string): void;
  dispose(this: void): void;
}

interface PendingComparison {
  root: string;
  abort: AbortController;
  promise: Promise<FileChange[]>;
  consumers: number;
}

export function createChangeQueries(
  access: GitApiAccess,
  cli: GitCli,
): ChangeQueries {
  const cache = new ComparisonCache<{
    root: string;
    files: FileChange[];
  }>();
  const pending = new Map<string, PendingComparison>();
  let disposed = false;
  const keyFor = (id: string, sha: string, parent: string | null) =>
    `${JSON.stringify(id)}\0${sha}\0${parent ?? ''}`;
  const closed = () =>
    new DOMException('The comparison is no longer available.', 'AbortError');
  const checkRepository = (id: string, root: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (disposed || access.repository(id).rootUri.fsPath !== root)
      throw closed();
  };

  const cancel = (key: string, work: PendingComparison, reason: Error) => {
    if (pending.get(key) === work) pending.delete(key);
    work.abort.abort(reason);
  };

  const invalidate = (id: string) => {
    const prefix = `${JSON.stringify(id)}\0`;

    cache.deleteMatching(prefix);
    for (const [key, work] of pending)
      if (key.startsWith(prefix)) cancel(key, work, closed());
  };

  const consume = (
    key: string,
    work: PendingComparison,
    signal?: AbortSignal,
  ): Promise<FileChange[]> => {
    work.consumers++;

    return new Promise((resolve, reject) => {
      let settled = false;
      const release = (reason?: Error) => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', cancelConsumer);
        work.abort.signal.removeEventListener('abort', cancelProducer);
        if (--work.consumers === 0 && pending.get(key) === work)
          cancel(key, work, reason ?? closed());

        return true;
      };

      const cancelConsumer = () => {
        const error = readCancellationError(signal?.reason);

        if (release(error)) reject(error);
      };

      const cancelProducer = () => {
        if (release()) reject(readCancellationError(work.abort.signal.reason));
      };

      signal?.addEventListener('abort', cancelConsumer, { once: true });
      work.abort.signal.addEventListener('abort', cancelProducer, {
        once: true,
      });
      work.promise.then(
        (files) => {
          if (release()) resolve(structuredClone(files));
        },
        (error: unknown) => {
          if (release())
            reject(
              error instanceof Error
                ? error
                : new Error('Reading the comparison failed.', { cause: error }),
            );
        },
      );
      if (signal?.aborted) cancelConsumer();
      else if (work.abort.signal.aborted) cancelProducer();
    });
  };

  const load = async (
    id: string,
    sha: string,
    parent: string | null,
    repo: GitRepository,
    signal: AbortSignal,
  ) => {
    const root = repo.rootUri.fsPath;

    checkRepository(id, root, signal);
    let parents: string[];

    try {
      parents = await readObjectParents(cli, id, sha, signal);
    } catch {
      checkRepository(id, root, signal);
      throw new Error(
        'The commit or parent object is unavailable. Retry after making it available through Git. No fetch was started.',
      );
    }

    checkRepository(id, root, signal);
    if (parent === null ? parents.length !== 0 : !parents.includes(parent))
      throw new Error('Select an actual parent comparison.');
    let files: FileChange[];

    if (parent === null)
      files = rootChanges(
        await cli.run(
          id,
          [
            'diff-tree',
            '--root',
            '--no-commit-id',
            '--name-status',
            '-r',
            '-z',
            '-M',
            sha,
            '--',
          ],
          signal,
        ),
      );
    else {
      try {
        await readWithCancellation(() => repo.getCommit(parent), signal);
      } catch {
        checkRepository(id, root, signal);
        throw new Error(
          'The parent object is unavailable, possibly in a shallow repository. Retry after making it available through Git. No fetch was started.',
        );
      }

      checkRepository(id, root, signal);
      files = (
        await readWithCancellation(() => repo.diffBetween(parent, sha), signal)
      ).map((item) => fromApiChange(item, repo.rootUri.fsPath));
    }

    checkRepository(id, root, signal);

    return files;
  };

  const query: ChangeQueries = Object.assign(
    async (
      id: string,
      sha: string,
      parent: string | null,
      signal?: AbortSignal,
    ) => {
      if (signal?.aborted) throw readCancellationError(signal.reason);
      if (disposed) throw closed();
      const repository = access.repository(id);
      const root = repository.rootUri.fsPath;
      const key = keyFor(id, sha, parent);
      const cached = cache.get(key);
      let work = pending.get(key);

      if ((cached && cached.root !== root) || (work && work.root !== root)) {
        invalidate(id);
        work = undefined;
      } else if (cached) return structuredClone(cached.files);

      if (!work) {
        const abort = new AbortController();
        const promise = backgroundRead(
          (owner) => load(id, sha, parent, repository, owner),
          abort.signal,
        )
          .then((files) => {
            checkRepository(id, root, abort.signal);
            if (pending.get(key)?.abort !== abort) throw closed();
            cache.set(key, { root, files: structuredClone(files) });

            return files;
          })
          .finally(() => {
            if (pending.get(key)?.abort === abort) pending.delete(key);
          });

        work = { root, abort, promise, consumers: 0 };
        pending.set(key, work);
      }

      return consume(key, work, signal);
    },
    {
      invalidate,
      dispose() {
        disposed = true;
        cache.deleteMatching('');
        for (const [key, work] of pending) cancel(key, work, closed());
      },
    },
  );

  return query;
}
