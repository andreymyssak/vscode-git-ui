import { expect, test, vi } from 'vitest';

import type { GitApiAccess } from '../../src/extension/git/api';
import type { GitCli } from '../../src/extension/git/cli';
import { createHistoryQueries } from '../../src/extension/git/history';
import { completeHistoryShallow } from '../fixtures/history-shallow';

const tips = Array.from({ length: 1000 }, (_, index) =>
  (index + 1).toString(16).padStart(40, '0'),
);

test('ordinary history uses native paging and oversized pinned scopes use bounded stdin reads', async (t) => {
  const record = { hash: tips[0]!, parents: [tips[1]!], message: 'Subject' };
  const log = vi.fn(async () => [record]);
  const calls: {
    args: readonly string[];
    input: string | Buffer | undefined;
  }[] = [];
  const cli = {
    readOnly() {
      return this;
    },
    async stream(
      _id: string,
      args: readonly string[],
      consume: (chunk: Buffer) => boolean,
      _signal?: AbortSignal,
      input?: string | Buffer,
    ) {
      calls.push({ args, input });
      consume(
        Buffer.from(
          [
            record.hash,
            tips[1],
            'Ada',
            'ada@example.test',
            '1700000000',
            '1700000000',
            record.message,
            '',
          ].join('\0'),
        ),
      );
    },
  } as unknown as GitCli;
  const reader = createHistoryQueries(
    {
      repository: () => ({
        state: { HEAD: { name: 'main', commit: record.hash } },
        getRefs: async () =>
          tips.map((commit, index) => ({
            type: 0,
            name: `branch-${index}`,
            commit,
          })),
        getCommit: async () => record,
        log,
      }),
    } as unknown as GitApiAccess,
    cli,
    Date.now,
    completeHistoryShallow,
  );

  t.onTestFinished(() => reader.dispose());
  const lazy = { kind: 'lazy-enrichment' as const, receive() {} };

  await reader.page(
    'one',
    { scope: { kind: 'head' }, text: '', cursor: null },
    undefined,
    undefined,
    undefined,
    lazy,
  );
  expect(log).toHaveBeenCalledTimes(1);
  const large = await reader.page(
    'one',
    { scope: { kind: 'all' }, text: '', cursor: null },
    undefined,
    undefined,
    undefined,
    lazy,
  );

  expect(log).toHaveBeenCalledTimes(1);
  expect(large.commits[0]?.sha).toBe(record.hash);
  expect(large.scopeId.length).toBeLessThanOrEqual(64);
  expect(calls[0]?.args).toContain('--stdin');
  expect(calls[0]?.args.join(' ').length).toBeLessThan(1000);
  expect(String(calls[0]?.input).trim().split('\n')).toEqual(tips);
});
