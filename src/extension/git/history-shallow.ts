import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { hasErrorCode } from '../../shared/validation';
import type { GitApiAccess } from './api';
import type { GitCli } from './cli';
import { isHistoryObjectId } from './history-records';

/** A branch tip does not describe the ancestry available in a shallow clone. */
export function createHistoryShallow(access: GitApiAccess, reader: GitCli) {
  const paths = new Map<string, string>();
  const lifetimes = new Map<string, symbol>();
  let closed = false;
  const path = async (id: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (closed) throw new Error('History reader is disposed.');
    const root = access.repository(id).rootUri.fsPath;
    const lifetime = lifetimes.get(id) ?? Symbol();

    lifetimes.set(id, lifetime);
    const cached = paths.get(id);

    if (cached) return cached;
    const output = await reader
      .readOnly(signal)
      .run(id, ['rev-parse', '--git-path', 'shallow']);
    const filename = output.replace(/\r?\n$/, '');

    if (!filename || filename.includes('\0'))
      throw new Error('Git returned an invalid shallow history path.');
    const target = resolve(root, filename);
    const resolved = join(await realpath(dirname(target)), basename(target));

    signal?.throwIfAborted();
    if (closed || lifetime !== lifetimes.get(id))
      throw new Error('History changed while resolving shallow metadata.');
    paths.set(id, resolved);

    return resolved;
  };

  return {
    path,
    async identity(id: string, signal?: AbortSignal): Promise<string | null> {
      try {
        const filename = await path(id, signal);
        let content: string;

        try {
          content = await readFile(filename, { encoding: 'utf8', signal });
        } catch (error) {
          if (hasErrorCode(error, 'ENOENT')) return 'complete';
          throw error;
        }

        signal?.throwIfAborted();
        const ids = content.split(/\r?\n/).filter(Boolean);

        if (!ids.every(isHistoryObjectId)) return null;

        return ids.length
          ? createHash('sha256')
              .update([...new Set(ids)].sort().join('\n'))
              .digest('hex')
          : 'complete';
      } catch {
        signal?.throwIfAborted();

        return null;
      }
    },
    invalidate(id: string) {
      paths.delete(id);
      lifetimes.delete(id);
    },
    dispose() {
      closed = true;
      paths.clear();
      lifetimes.clear();
    },
  };
}

export type HistoryShallow = ReturnType<typeof createHistoryShallow>;
