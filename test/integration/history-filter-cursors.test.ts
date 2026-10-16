import { expect, test, vi } from 'vitest';

import type { GitApiAccess } from '../../src/extension/git/api';
import { GitCli } from '../../src/extension/git/cli';
import { createHistoryQueries } from '../../src/extension/git/history';
import type { HistoryInput } from '../../src/shared/model';
import { commitLinearHistory, createFixture } from '../fixtures/repository';

test('filtered cursors and cached revisits preserve sparse offsets without hydrating each commit', async (t) => {
  const fixture = await createFixture({ prefix: 'git-ui filter cursor ' });

  t.onTestFinished(() => fixture.dispose());
  const base = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
  const head = await commitLinearHistory(
    fixture,
    base,
    Array.from({ length: 2321 }, (_, index) => ({
      message: index % 11 === 0 ? `Sparse ${index / 11}` : `Other ${index}`,
      date: index % 11 === 0 ? '1791457200 +0000' : '1790420400 +0000',
    })),
  );

  await fixture.runGit(['update-ref', 'refs/heads/main', head]);
  const getCommit = vi.fn(async (ref: string) => {
    if (ref !== 'HEAD')
      throw new Error('Filtered history must batch commit metadata.');

    return { hash: head, parents: [base], message: 'Tip' };
  });
  const access = {
    api: { git: { path: 'git' } },
    repository: () => ({
      rootUri: { fsPath: fixture.root },
      state: { HEAD: { name: 'main', commit: head } },
      getRefs: async () => [{ type: 0, name: 'main', commit: head }],
      getCommit,
      log: async () => {
        throw new Error('Native log cannot express these date filters.');
      },
    }),
  } as unknown as GitApiAccess;
  const streamed = vi.spyOn(GitCli.prototype, 'stream');

  t.onTestFinished(() => streamed.mockRestore());
  const reader = createHistoryQueries(access, new GitCli(access));
  const query: HistoryInput = {
    scope: { kind: 'head' },
    text: '',
    cursor: null,
    filters: {
      regex: false,
      matchCase: false,
      author: { kind: 'all' },
      date: { kind: 'range', from: '2026-10-08', to: '2026-10-08' },
    },
  };
  const first = await reader.page('fixture', query);
  const second = await reader.page('fixture', {
    ...query,
    cursor: first.nextCursor,
  });

  expect(first.commits).toHaveLength(200);
  expect(second.commits.map((commit) => commit.message.trim())).toEqual(
    Array.from({ length: 11 }, (_, index) => `Sparse ${10 - index}`),
  );
  expect(second.nextCursor).toBeNull();
  const revisit = await reader.page('fixture', query);
  const resumed = await reader.page('fixture', {
    ...query,
    cursor: revisit.nextCursor,
  });

  expect(revisit.commits).toEqual(first.commits);
  expect(resumed.commits).toEqual(second.commits);
  expect(resumed.nextCursor).toBeNull();
  expect(
    streamed.mock.calls.filter((call) => call[1][0] === 'log'),
  ).toHaveLength(2);
  expect(getCommit.mock.calls.every(([ref]) => ref === 'HEAD')).toBe(true);
});
