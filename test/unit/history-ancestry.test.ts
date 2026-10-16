import { expect, test, vi } from 'vitest';

import type { GitCli } from '../../src/extension/git/cli';
import { createHistoryAnnotations } from '../../src/extension/git/history-annotations';
import type { CommitRecord } from '../../src/shared/model';

const sha = (value: number) => value.toString(16).padStart(40, '0');
const snapshot = Symbol();
const commits = (...values: number[]): CommitRecord[] =>
  values.map((value) => ({
    sha: sha(value),
    parents: [],
    message: '',
    authorName: null,
    authorEmail: null,
    authorDate: null,
    commitDate: null,
  }));
const input = (...values: number[]) => ({
  snapshot,
  repositoryId: 'one',
  head: sha(1),
  tips: [sha(1), sha(2)],
  commits: commits(...values),
});

function controlledReader() {
  const runs: {
    consume: (value: Buffer) => boolean;
    signal: AbortSignal;
    finish(): void;
  }[] = [];
  const cli = {
    readOnly() {
      return this;
    },
    stream: (
      _id: string,
      _args: string[],
      consume: (value: Buffer) => boolean,
      signal: AbortSignal,
    ) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => {
          reject(signal.reason);
        };

        signal.addEventListener('abort', abort, { once: true });
        runs.push({
          consume,
          signal,
          finish() {
            signal.removeEventListener('abort', abort);
            resolve();
          },
        });
        if (signal.aborted) abort();
      }),
  } as unknown as GitCli;

  return { runs, reader: createHistoryAnnotations(cli) };
}

test('overlapping pages share a streamed ancestry read and resolve their own membership', async (t) => {
  const { reader, runs } = controlledReader();

  t.onTestFinished(() => reader.dispose());
  const first = reader.read(input(1, 2));
  const second = reader.read(input(3, 99));

  await vi.waitFor(() => expect(runs).toHaveLength(1));
  runs[0]!.consume(Buffer.from(`${sha(1)}\n${sha(2)}\n${sha(3)}\n`));
  expect(await first).toEqual([sha(1), sha(2)]);
  runs[0]!.finish();
  expect(await second).toEqual([sha(3)]);
  expect(await reader.read(input(1, 99))).toEqual([sha(1)]);
  expect(runs).toHaveLength(1);
});

test('ancestry retention is bounded while keeping nearby pages reusable', async (t) => {
  let reads = 0;
  const reader = createHistoryAnnotations({
    readOnly() {
      return this;
    },
    async stream(
      _id: string,
      _args: string[],
      consume: (value: Buffer) => boolean,
    ) {
      reads++;
      for (let value = 1; value <= 10000; value++)
        if (!consume(Buffer.from(sha(value) + '\n'))) break;
    },
  } as unknown as GitCli);

  t.onTestFinished(() => reader.dispose());
  expect(await reader.read(input(10000))).toEqual([sha(10000)]);
  expect(await reader.read(input(200))).toEqual([sha(200)]);
  expect(reads).toBe(1);
  expect(await reader.read(input(9000))).toEqual([sha(9000)]);
  expect(reads).toBe(2);
});

test('one cancelled page preserves other consumers and the last cancellation stops the read', async (t) => {
  const { reader, runs } = controlledReader();

  t.onTestFinished(() => reader.dispose());
  const one = new AbortController();
  const two = new AbortController();
  const reason = new Error('Caller left');
  const first = reader.read({ ...input(99), signal: one.signal });
  const second = reader.read({ ...input(100), signal: two.signal });
  const rejected = expect(first).rejects.toBe(reason);

  await vi.waitFor(() => expect(runs).toHaveLength(1));
  one.abort(reason);
  await rejected;
  expect(runs[0]!.signal.aborted).toBe(false);
  const last = expect(second).rejects.toMatchObject({ name: 'AbortError' });

  two.abort();
  await last;
  expect(runs[0]!.signal.aborted).toBe(true);
});

test('invalidation retires old ancestry without cancelling a replacement reader', async (t) => {
  const { reader, runs } = controlledReader();

  t.onTestFinished(() => reader.dispose());
  const first = reader.read(input(99));
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });

  await vi.waitFor(() => expect(runs).toHaveLength(1));
  reader.invalidate('one');
  await rejected;
  const replacement = reader.read(input(99));

  await vi.waitFor(() => expect(runs).toHaveLength(2));
  runs[0]!.finish();
  runs[1]!.consume(Buffer.from(sha(99) + '\n'));
  expect(await replacement).toEqual([sha(99)]);
});

test('a changed HEAD gets fresh ancestry and malformed output is never cached', async (t) => {
  let reads = 0;
  const reader = createHistoryAnnotations({
    readOnly() {
      return this;
    },
    async stream(
      _id: string,
      args: string[],
      consume: (value: Buffer) => boolean,
    ) {
      reads++;
      consume(Buffer.from(reads === 1 ? 'invalid\n' : args[1] + '\n'));
    },
  } as unknown as GitCli);

  t.onTestFinished(() => reader.dispose());
  await expect(reader.read(input(1))).rejects.toThrow(/ancestry/);
  expect(await reader.read(input(1))).toEqual([sha(1)]);
  expect(await reader.read({ ...input(2), head: sha(2) })).toEqual([sha(2)]);
  expect(reads).toBe(3);
});
