import { describe, expect, it } from 'vitest';

import { createBlameQueries } from '../../src/extension/git/blame';
import type { BlameQuery } from '../../src/extension/git/blame-model';
import { blameSha, porcelainRecord } from '../fixtures/blame';
import { squashAccess } from '../fixtures/squash-repository';

const contents: BlameQuery = {
  repositoryId: 'fixture',
  ignoreWhitespace: false,
  source: {
    kind: 'contents',
    path: 'sample.txt',
    headSha: blameSha,
    contents: 'first\n',
  },
};

function fixture() {
  const calls: { args: readonly string[]; input: string | Buffer | null }[] =
    [];
  let head = blameSha;
  let failure: Error | null = null;
  let afterRead = () => {};

  const read = createBlameQueries(squashAccess('/unused'), {
    run: async (_id, args) => {
      calls.push({ args, input: null });
      if (args.includes('rev-parse')) {
        if (failure) throw failure;

        return head + '\n';
      }

      if (args.includes('ls-tree')) return 'sample.txt\0';
      if (failure) throw failure;

      return porcelainRecord();
    },
    runWithInput: async (_id, args, input) => {
      calls.push({ args, input });
      if (failure) throw failure;
      afterRead();

      return porcelainRecord();
    },
  });

  return {
    read,
    calls,
    setHead: (value: string) => {
      head = value;
    },
    setFailure: (value: Error) => {
      failure = value;
    },
    afterRead: (value: () => void) => {
      afterRead = value;
    },
  };
}

describe('blame reader boundaries', () => {
  it('reads exact immutable revisions with options separated from the path', async () => {
    const f = fixture();
    const result = await f.read({
      repositoryId: 'fixture',
      ignoreWhitespace: true,
      source: { kind: 'revision', path: '-ü.txt', sha: blameSha },
    });

    expect(result).toMatchObject({ kind: 'blame', lines: [{ sha: blameSha }] });
    expect(f.calls).toEqual([
      {
        args: [
          'blame',
          '--encoding=UTF-8',
          '--line-porcelain',
          '--root',
          '-w',
          blameSha,
          '--',
          '-ü.txt',
        ],
        input: null,
      },
    ]);
  });

  it('sends the displayed text through stdin without a final revision', async () => {
    const f = fixture();

    await f.read(contents);
    expect(f.calls.find(({ input }) => input !== null)).toEqual({
      args: [
        'blame',
        '--encoding=UTF-8',
        '--line-porcelain',
        '--root',
        '--contents',
        '-',
        '--',
        'sample.txt',
      ],
      input: 'first\n',
    });
  });

  it('rejects a snapshot after HEAD changes during the read', async () => {
    const f = fixture();

    f.afterRead(() => f.setHead('b'.repeat(40)));
    await expect(f.read(contents)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects an already stale snapshot', async () => {
    const f = fixture();

    f.setHead('b'.repeat(40));
    await expect(f.read(contents)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(f.calls.some(({ input }) => input !== null)).toBe(false);
  });

  it('returns no history only for a verified unborn HEAD', async () => {
    const f = fixture();

    f.setFailure(
      Object.assign(new Error('No HEAD'), { code: 1, stdout: '', stderr: '' }),
    );
    expect(await f.read(contents)).toEqual({ kind: 'no-history' });
  });

  it('does not hide permission or missing object failures', async () => {
    const f = fixture();

    f.setFailure(
      Object.assign(new Error('Cannot read objects'), { code: 128 }),
    );
    await expect(f.read(contents)).rejects.toThrow('Cannot read objects');
  });

  it('cancels without issuing a Git read', async () => {
    const f = fixture();
    const cancel = new AbortController();

    cancel.abort();
    await expect(f.read(contents, cancel.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(f.calls).toEqual([]);
  });

  it.each(['../outside', '/absolute', 'a/../b', 'x\0y'])(
    'rejects unsafe paths: %s',
    async (path) => {
      const f = fixture();

      await expect(
        f.read({
          ...contents,
          source: { kind: 'revision', path, sha: blameSha },
        }),
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    },
  );

  it('rejects revision expressions at the immutable revision boundary', async () => {
    const f = fixture();

    await expect(
      f.read({
        ...contents,
        source: { kind: 'revision', path: 'sample.txt', sha: '--all' },
      }),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
});
