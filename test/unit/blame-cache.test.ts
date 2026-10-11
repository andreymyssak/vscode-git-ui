import { expect, it, vi } from 'vitest';

import type {
  BlameLine,
  BlameQuery,
  BlameResult,
} from '../../src/extension/git/blame-model';
import { BlameReadCache } from '../../src/extension/native/blame-cache';
import { deferred } from '../fixtures/deferred';

const query = (index: number): BlameQuery => ({
  repositoryId: 'file:///fixture',
  ignoreWhitespace: false,
  source: {
    kind: 'revision',
    path: 'sample.txt',
    sha: index.toString(16).padStart(40, '0'),
  },
});
const signal = () => new AbortController().signal;

it('evicts old revisions and invalidates repository cache entries', async () => {
  let reads = 0;
  const cache = new BlameReadCache(async () => {
    reads++;

    return {
      kind: 'blame',
      lines: [{ kind: 'uncommitted', line: 1, text: 'first' }],
    };
  });

  for (let index = 1; index <= 9; index++)
    await cache.read(query(index), signal());
  await cache.read(query(9), signal());
  expect(reads).toBe(9);
  await cache.read(query(1), signal());
  expect(reads).toBe(10);
  cache.invalidate('file:///fixture');
  await cache.read(query(9), signal());
  expect(reads).toBe(11);
  cache.dispose();
});
it('bounds cached lines and never caches mutable displayed contents', async () => {
  let reads = 0;
  const lines: BlameLine[] = Array.from({ length: 60_000 }, (_, index) => ({
    kind: 'uncommitted',
    line: index + 1,
    text: 'x',
  }));
  const cache = new BlameReadCache(async () => {
    reads++;

    return { kind: 'blame', lines };
  });

  await cache.read(query(1), signal());
  await cache.read(query(2), signal());
  await cache.read(query(1), signal());
  expect(reads).toBe(3);
  const mutable: BlameQuery = {
    ...query(1),
    source: {
      kind: 'contents',
      path: 'sample.txt',
      headSha: 'a'.repeat(40),
      contents: 'unsaved\n',
    },
  };

  await cache.read(mutable, signal());
  await cache.read(mutable, signal());
  expect(reads).toBe(5);
  cache.dispose();
});
it('does not retain an aborted or failed read', async () => {
  let reads = 0;
  const controller = new AbortController();
  const cache = new BlameReadCache(async () => {
    reads++;
    if (reads === 1) controller.abort();
    if (reads === 2) throw new Error('Read failed');

    return { kind: 'blame', lines: [] };
  });

  await expect(cache.read(query(1), controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  await expect(cache.read(query(1), signal())).rejects.toThrow('Read failed');
  await cache.read(query(1), signal());
  expect(reads).toBe(3);
  cache.dispose();
});

it('shares pending work while keeping each reader cancellation independent', async () => {
  const pending = deferred<BlameResult>();
  let producer: AbortSignal | undefined;
  const read = vi.fn((_query: BlameQuery, signal?: AbortSignal) => {
    producer = signal;

    return pending.promise;
  });
  const cache = new BlameReadCache(read);
  const first = new AbortController();
  const firstRead = cache.read(query(1), first.signal);
  const cancelledRead = expect(firstRead).rejects.toMatchObject({
    name: 'AbortError',
  });
  const secondRead = cache.read(query(1), signal());

  expect(read).toHaveBeenCalledTimes(1);
  first.abort();
  await cancelledRead;
  expect(producer?.aborted).toBe(false);
  pending.resolve({ kind: 'blame', lines: [] });
  await expect(secondRead).resolves.toEqual({ kind: 'blame', lines: [] });
  cache.dispose();
});

it('abandons a producer after its last reader and starts fresh on retry', async () => {
  const pending = deferred<BlameResult>();
  const producers: AbortSignal[] = [];
  const cache = new BlameReadCache(async (_query, signal) => {
    if (signal) producers.push(signal);

    return producers.length === 1
      ? pending.promise
      : { kind: 'blame', lines: [] };
  });
  const controller = new AbortController();
  const first = expect(
    cache.read(query(1), controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });

  controller.abort();
  await first;
  expect(producers[0]?.aborted).toBe(true);
  await cache.read(query(1), signal());
  expect(producers).toHaveLength(2);
  pending.resolve({
    kind: 'blame',
    lines: [{ kind: 'uncommitted', line: 1, text: 'obsolete' }],
  });
  await Promise.resolve();
  await expect(cache.read(query(1), signal())).resolves.toEqual({
    kind: 'blame',
    lines: [],
  });
  cache.dispose();
});

it('invalidates pending readers and separates encoding and displayed contents', async () => {
  const pending = deferred<BlameResult>();
  const read = vi.fn(async () => pending.promise);
  const cache = new BlameReadCache(read);
  const reads = [
    query(1),
    { ...query(1), encoding: 'iso88591' },
    {
      ...query(1),
      source: {
        kind: 'contents' as const,
        headSha: 'a'.repeat(40),
        path: 'sample.txt',
        contents: 'one',
      },
    },
    {
      ...query(1),
      source: {
        kind: 'contents' as const,
        headSha: 'a'.repeat(40),
        path: 'sample.txt',
        contents: 'two',
      },
    },
  ].map((value) =>
    expect(cache.read(value, signal())).rejects.toMatchObject({
      name: 'AbortError',
    }),
  );

  expect(read).toHaveBeenCalledTimes(4);
  cache.invalidate('file:///fixture');
  await Promise.all(reads);
  pending.resolve({ kind: 'blame', lines: [] });
  cache.dispose();
});
