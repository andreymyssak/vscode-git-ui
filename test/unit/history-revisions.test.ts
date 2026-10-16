import { expect, test } from 'vitest';

import type { GitCli } from '../../src/extension/git/cli';
import {
  prepareHistoryFilter,
  readFilteredHistoryPage,
} from '../../src/extension/git/history-filter-page';
import { readAuthors } from '../../src/extension/git/history-filters';
import { normalizeHistoryFilters } from '../../src/shared/history-filters';

const tips = Array.from({ length: 10000 }, (_, index) =>
  (index + 1).toString(16).padStart(40, '0'),
);

function fixture() {
  const calls: {
    args: readonly string[];
    input: string | Buffer | undefined;
  }[] = [];
  const cli = {
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
          args.includes('--format=%an%x00%ae')
            ? 'Ada\0ada@example.test\0'
            : `${tips[0]}\0${tips[1]}\0Ada\0ada@example.test\0${1700000000}\0${1700000000}\0Subject\0`,
        ),
      );
    },
  } as unknown as GitCli;

  return { cli, calls };
}

test('large author scopes keep captured revisions in stdin instead of the argument vector', async () => {
  const { cli, calls } = fixture();

  expect(await readAuthors(cli, 'one', tips)).toEqual([
    { name: 'Ada', email: 'ada@example.test' },
  ]);
  expect(calls[0]?.args).toContain('--stdin');
  expect(calls[0]?.args.join(' ').length).toBeLessThan(1000);
  expect(String(calls[0]?.input).trim().split('\n')).toEqual(tips);
});

test('filtered history keeps a large captured scope in stdin and decodes its records', async () => {
  const { cli, calls } = fixture();
  const query = await prepareHistoryFilter(cli, 'one', {
    tips,
    text: '',
    filters: normalizeHistoryFilters(),
    now: 0,
  });
  const page = await readFilteredHistoryPage(cli, 'one', query, 0);

  expect(page.commits.map((record) => record.sha)).toEqual([tips[0]]);
  expect(calls[0]?.args).toContain('--stdin');
  expect(calls[0]?.args.join(' ').length).toBeLessThan(1000);
  expect(String(calls[0]?.input).trim().split('\n')).toEqual(tips);
});
