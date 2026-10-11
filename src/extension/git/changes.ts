import { randomUUID } from 'node:crypto';
import { relative, sep } from 'node:path';

import type { FileChange } from '../../shared/model';
import type { GitApiAccess, GitChange } from './api';
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

export function createChangeQueries(
  access: GitApiAccess,
  cli: GitCli,
): (id: string, sha: string, parent: string | null) => Promise<FileChange[]> {
  const cache = new ComparisonCache<FileChange[]>();
  const pending = new Map<string, Promise<FileChange[]>>();

  const load = async (id: string, sha: string, parent: string | null) => {
    const repo = access.repository(id);
    const key = JSON.stringify([id, sha, parent]);
    const cached = cache.get(key);

    if (cached) return structuredClone(cached);
    let parents: string[];

    try {
      parents = await readObjectParents(cli, id, sha);
    } catch {
      throw new Error(
        'The commit or parent object is unavailable. Retry after making it available through Git. No fetch was started.',
      );
    }

    if (parent === null ? parents.length !== 0 : !parents.includes(parent))
      throw new Error('Select an actual parent comparison.');
    let files: FileChange[];

    if (parent === null)
      files = rootChanges(
        await cli.run(id, [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--name-status',
          '-r',
          '-z',
          '-M',
          sha,
          '--',
        ]),
      );
    else {
      try {
        await repo.getCommit(parent);
      } catch {
        throw new Error(
          'The parent object is unavailable, possibly in a shallow repository. Retry after making it available through Git. No fetch was started.',
        );
      }

      files = (await repo.diffBetween(parent, sha)).map((item) =>
        fromApiChange(item, repo.rootUri.fsPath),
      );
    }

    cache.set(key, structuredClone(files));

    return files;
  };

  return async (id, sha, parent) => {
    access.repository(id);
    const key = JSON.stringify([id, sha, parent]);
    let work = pending.get(key);

    if (!work) {
      work = load(id, sha, parent);
      pending.set(key, work);
    }

    try {
      return structuredClone(await work);
    } finally {
      if (pending.get(key) === work) pending.delete(key);
    }
  };
}
