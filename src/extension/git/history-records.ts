import { StringDecoder } from 'node:string_decoder';

import type { CommitRecord } from '../../shared/model';
import type { GitCli } from './cli';

const objectId = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;

export function isHistoryObjectId(value: string): boolean {
  return objectId.test(value);
}

/** NUL framing keeps newlines and split UTF-8 code points inside each field. */
export function historyFields(
  width: number,
  consume: (fields: string[]) => boolean,
) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let fields: string[] = [];
  let stopped = false;

  return {
    write(this: void, chunk: Buffer): boolean {
      if (stopped) return false;
      const text = decoder.write(chunk);
      let start = 0;

      for (
        let end = text.indexOf('\0');
        end !== -1;
        end = text.indexOf('\0', start)
      ) {
        fields.push(pending + text.slice(start, end));
        pending = '';
        start = end + 1;
        if (fields.length === width) {
          const record = fields;

          fields = [];
          if (!consume(record)) {
            stopped = true;

            return false;
          }
        }
      }

      pending += text.slice(start);

      return true;
    },
    finish(this: void): void {
      if (stopped) return;
      pending += decoder.end();
      if (pending || fields.length)
        throw new Error('Git returned incomplete history metadata.');
    },
  };
}

export function historyCommit(fields: string[]): CommitRecord {
  const [
    sha,
    rawParents,
    authorName,
    authorEmail,
    authoredAt,
    committedAt,
    message,
  ] = fields;

  if (
    sha === undefined ||
    rawParents === undefined ||
    authorName === undefined ||
    authorEmail === undefined ||
    authoredAt === undefined ||
    committedAt === undefined ||
    message === undefined ||
    fields.length !== 7 ||
    !objectId.test(sha)
  )
    throw new Error('Git returned invalid history metadata.');
  const parents = rawParents.split(' ').filter(Boolean);
  const date = (value: string) => {
    const timestamp = Number(value) * 1000;

    if (
      !/^-?\d+$/.test(value) ||
      !Number.isFinite(new Date(timestamp).getTime())
    )
      throw new Error('Git returned an invalid history date.');

    return new Date(timestamp).toISOString();
  };

  if (!parents.every((parent) => objectId.test(parent)))
    throw new Error('Git returned an invalid history parent.');

  return {
    sha,
    parents,
    authorName,
    authorEmail,
    authorDate: date(authoredAt),
    commitDate: date(committedAt),
    message,
  };
}

/** %P hides shallow parents. Recover only rootless page objects, in one batch. */
export async function restoreHistoryParents(
  cli: GitCli,
  id: string,
  commits: CommitRecord[],
  signal?: AbortSignal,
): Promise<void> {
  const missing = commits.filter((commit) => !commit.parents.length);

  if (!missing.length) return;
  let index = 0;
  let header = '';
  let remaining = 0;
  let parts: Buffer[] = [];
  let state: 'header' | 'object' | 'terminator' = 'header';
  const read = (chunk: Buffer): boolean => {
    let position = 0;

    while (position < chunk.length) {
      if (state === 'header') {
        const end = chunk.indexOf(10, position);

        if (end === -1) {
          header += chunk.toString('ascii', position);
          if (header.length > 256)
            throw new Error('Git returned an invalid object header.');
          break;
        }

        header += chunk.toString('ascii', position, end);
        const match = /^(\S+) commit (\d+)$/.exec(header);
        const commit = missing[index];

        if (
          !match ||
          !commit ||
          match[1] !== commit.sha ||
          !isHistoryObjectId(match[1])
        )
          throw new Error('Git returned an unexpected history object.');
        remaining = Number(match[2]);
        if (!Number.isSafeInteger(remaining) || remaining <= 0)
          throw new Error('Git returned an invalid object size.');
        header = '';
        position = end + 1;
        state = 'object';
      } else if (state === 'object') {
        const count = Math.min(remaining, chunk.length - position);

        parts.push(chunk.subarray(position, position + count));
        remaining -= count;
        position += count;
        if (remaining === 0) {
          const object = Buffer.concat(parts);
          const end = object.indexOf('\n\n');
          const rawHeader = object
            .subarray(0, end === -1 ? object.length : end)
            .toString('utf8');
          const commit = missing[index];

          if (!commit)
            throw new Error('Git returned an unexpected history object.');
          commit.parents = rawHeader
            .split('\n')
            .filter((line) => line.startsWith('parent '))
            .map((line) => {
              const parent = line.slice(7);

              if (!isHistoryObjectId(parent))
                throw new Error('Git returned an invalid history parent.');

              return parent;
            });
          parts = [];
          state = 'terminator';
        }
      } else {
        if (chunk[position] !== 10)
          throw new Error('Git returned an invalid object terminator.');
        position++;
        index++;
        state = 'header';
      }
    }

    return true;
  };

  await cli.stream(
    id,
    ['cat-file', '--batch'],
    read,
    signal,
    missing.map((commit) => commit.sha).join('\n') + '\n',
  );
  if (state !== 'header' || header || index !== missing.length)
    throw new Error('Git returned incomplete history objects.');
}
