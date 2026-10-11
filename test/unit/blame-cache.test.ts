import { expect, it } from 'vitest';

import type {
  BlameLine,
  BlameQuery,
} from '../../src/extension/git/blame-model';
import { BlameReadCache } from '../../src/extension/native/blame-cache';

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

  await cache.read(query(1), controller.signal);
  await expect(cache.read(query(1), signal())).rejects.toThrow('Read failed');
  await cache.read(query(1), signal());
  expect(reads).toBe(3);
  cache.dispose();
});
