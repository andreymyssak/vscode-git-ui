import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GitCli } from '../../src/extension/git/cli';
import {
  prepareHistoryFilter,
  readFilteredHistoryPage,
} from '../../src/extension/git/history-filter-page';
import { readAuthors } from '../../src/extension/git/history-filters';
import type { AuthorIdentity, HistoryFilters } from '../../src/shared/model';
import type { Fixture } from '../fixtures/repository';
import { commitLinearHistory, createFixture } from '../fixtures/repository';
import { squashAccess } from '../fixtures/squash-repository';

const defaults: HistoryFilters = {
  regex: false,
  matchCase: false,
  author: { kind: 'all' },
  date: 'all',
};
const now = Date.UTC(2026, 9, 8, 12);
const bob = { name: 'Bob [dev]', email: 'Bob+dev@example.test' };

describe('streamed filtered history pages', () => {
  let fixture: Fixture;
  let cli: GitCli;
  let base: string;
  let prefix: string;
  let head: string;
  let sparseHead: string;
  let tree: string;

  async function addCommit(
    message: string,
    author: AuthorIdentity = bob,
    time = now - 3600000,
  ): Promise<string> {
    head = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'git',
        ['commit-tree', tree, '-p', head],
        {
          cwd: fixture.root,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: join(fixture.root, 'isolated-gitconfig'),
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: 'Committer',
            GIT_COMMITTER_EMAIL: 'committer@example.test',
            GIT_AUTHOR_DATE: '1700000000 +0000',
            GIT_COMMITTER_DATE: `${Math.floor(time / 1000)} +0000`,
          },
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      );

      child.stdin?.end(message);
    });

    return head;
  }

  const prepare = (filters = defaults, text = '', tips = [head]) =>
    prepareHistoryFilter(cli, 'fixture', { tips, filters, text, now });
  const subjects = async (filters = defaults, text = '') =>
    (
      await readFilteredHistoryPage(
        cli,
        'fixture',
        await prepare(filters, text),
        0,
      )
    ).commits.map((entry) => entry.message.trim());

  beforeAll(async () => {
    fixture = await createFixture({ prefix: 'git-ui streamed history ü ' });
    cli = new GitCli(squashAccess(fixture.root)).readOnly();
    base = head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    prefix = base.slice(0, Math.max(7, base.search(/[a-f]/i) + 1));
    tree = (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
    sparseHead = await commitLinearHistory(
      fixture,
      base,
      Array.from({ length: 2321 }, (_, index) => ({
        message: index % 11 === 0 ? `Sparse ${index / 11}` : `Other ${index}`,
        date: index % 11 === 0 ? '1791457200 +0000' : '1790420400 +0000',
      })),
    );
    await addCommit('Feature one\n');
    await addCommit('Feature two\n', {
      ...bob,
      email: bob.email.toLowerCase(),
    });
    await addCommit('Feature suffix\n', { ...bob, email: `x${bob.email}` });
    await addCommit('Literal [x].* MixedCase\n');
    await addCommit('Literal [x].* mixedcase\n');
    await addCommit('Old descendant\n', bob, now - 12 * 86400000);
    await addCommit('Name fallback\n', { name: bob.name, email: 'other@test' });
    await addCommit('--all\n');
    await addCommit(`Mention ${prefix}\n`);
    await addCommit(`Upper ${prefix.toUpperCase()}\n`);
    const start = new Date(2026, 9, 8).getTime();
    const end = new Date(2026, 9, 9).getTime();

    await addCommit('Boundary previous\n', bob, start - 1000);
    await addCommit('Boundary first\n', bob, start);
    await addCommit('Boundary last\n', bob, end - 1000);
    await addCommit('Boundary next\n', bob, end);
  });

  it('resumes the raw candidate offset after sparse date matches and includes only the local day', async () => {
    const filters: HistoryFilters = {
      ...defaults,
      date: { kind: 'range', from: '2026-10-08', to: '2026-10-08' },
    };
    const query = await prepare(filters, '', [sparseHead]);
    const first = await readFilteredHistoryPage(cli, 'fixture', query, 0);

    expect(first.commits).toHaveLength(200);
    expect(first.nextOffset).toBe(2210);
    const second = await readFilteredHistoryPage(
      cli,
      'fixture',
      query,
      first.nextOffset!,
    );

    expect(second.commits.map((entry) => entry.message.trim())).toEqual(
      Array.from({ length: 11 }, (_, index) => `Sparse ${10 - index}`),
    );
    expect(second.nextOffset).toBeNull();
    expect(await subjects(filters, 'Boundary')).toEqual([
      'Boundary last',
      'Boundary first',
    ]);
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  it('streams author discovery while retaining distinct case-sensitive identities', async () => {
    const stream = vi.spyOn(cli, 'stream');
    const authors = await readAuthors(cli, 'fixture', [head]);

    expect(authors).toHaveLength(5);
    expect(authors).toEqual(
      expect.arrayContaining([
        bob,
        { ...bob, email: bob.email.toLowerCase() },
        { name: bob.name, email: 'other@test' },
        { ...bob, email: `x${bob.email}` },
        { name: 'Fixture', email: 'fixture@example.test' },
      ]),
    );
    expect(
      stream.mock.calls.filter((call) => call[1][0] === 'log'),
    ).toHaveLength(1);
    stream.mockRestore();
  });

  it('returns sparse pages in native order without dropping the lookahead', async () => {
    const query = await prepare(defaults, 'Sparse', [sparseHead]);
    const stream = vi.spyOn(cli, 'stream');
    const first = await readFilteredHistoryPage(cli, 'fixture', query, 0);

    expect(first.commits).toHaveLength(200);
    expect(first.commits[0]?.message.trim()).toBe('Sparse 210');
    expect(first.commits[199]?.message.trim()).toBe('Sparse 11');
    expect(first.nextOffset).not.toBeNull();
    const second = await readFilteredHistoryPage(
      cli,
      'fixture',
      query,
      first.nextOffset!,
    );

    expect(second.commits.map((entry) => entry.message.trim())).toEqual(
      Array.from({ length: 11 }, (_, index) => `Sparse ${10 - index}`),
    );
    expect(second.nextOffset).toBeNull();
    expect(
      stream.mock.calls.filter((call) => call[1][0] === 'log'),
    ).toHaveLength(2);
    stream.mockRestore();
  });

  it('uses literal punctuation, requested case, and Git extended regex semantics', async () => {
    expect(await subjects(defaults, '[x].* mixedcase')).toEqual([
      'Literal [x].* mixedcase',
      'Literal [x].* MixedCase',
    ]);
    expect(
      await subjects({ ...defaults, matchCase: true }, '[x].* MixedCase'),
    ).toEqual(['Literal [x].* MixedCase']);
    expect(
      await subjects({ ...defaults, regex: true }, '^Feature (one|two)$'),
    ).toEqual(['Feature two', 'Feature one']);
    expect(await subjects(defaults, '--all')).toEqual(['--all']);
    await expect(subjects({ ...defaults, regex: true }, '[')).rejects.toThrow(
      'Invalid regular expression',
    );
  });

  it('postfilters exact case-sensitive email and exact punctuation-bearing name fallback', async () => {
    const selected: HistoryFilters = {
      ...defaults,
      author: { kind: 'selected', identities: [bob] },
    };

    expect(await subjects(selected, 'Feature')).toEqual(['Feature one']);
    expect(await subjects({ ...selected, regex: true }, '^Feature')).toEqual([
      'Feature one',
    ]);
    expect(
      await subjects(
        {
          ...defaults,
          author: {
            kind: 'selected',
            identities: [{ name: bob.name, email: '' }],
          },
        },
        '^',
      ),
    ).toEqual([]);
    expect(
      await subjects(
        {
          ...defaults,
          author: {
            kind: 'selected',
            identities: [{ name: bob.name, email: '' }],
          },
        },
        'Name fallback',
      ),
    ).toEqual(['Name fallback']);
  });

  it('pins Me identity and date bounds while keeping newer ancestors after an old descendant', async () => {
    await fixture.runGit(['config', 'user.email', bob.email]);
    const query = await prepare(
      { ...defaults, author: { kind: 'me' }, date: '24h' },
      'Feature',
    );

    await fixture.runGit(['config', 'user.email', bob.email.toLowerCase()]);
    const page = await readFilteredHistoryPage(cli, 'fixture', query, 0);

    expect(page.commits.map((entry) => entry.message.trim())).toEqual([
      'Feature one',
    ]);
    expect(page.commits[0]?.authorDate).toBe('2023-11-14T22:13:20.000Z');
    expect(page.commits[0]?.commitDate).toBe('2026-10-08T11:00:00.000Z');
  });

  it.each(['email', 'name', 'me'] as const)(
    'matches raw %s author identities when mailmap display is enabled',
    async (kind) => {
      const mailmap = join(fixture.root, '.mailmap');
      const previousEmail = (
        await fixture.runGit(['config', '--get', 'user.email'])
      ).trim();

      await writeFile(
        mailmap,
        `Mapped Author <mapped@example.test> ${bob.name} <${bob.email}>\n`,
      );
      await fixture.runGit(['config', 'log.mailmap', 'true']);
      await fixture.runGit(['config', 'user.email', bob.email]);
      try {
        expect(await readAuthors(cli, 'fixture', [head])).toContainEqual(bob);
        const author: HistoryFilters['author'] =
          kind === 'me'
            ? { kind: 'me' }
            : {
                kind: 'selected',
                identities: [
                  kind === 'email' ? bob : { name: bob.name, email: '' },
                ],
              };

        expect(await subjects({ ...defaults, author }, 'Feature one')).toEqual([
          'Feature one',
        ]);
      } finally {
        await fixture.runGit(['config', '--unset', 'log.mailmap']);
        await fixture.runGit(['config', 'user.email', previousEmail]);
        await rm(mailmap);
      }
    },
  );

  it('preserves hash-or-message union in topo order with the same author/date restrictions', async () => {
    const page = await readFilteredHistoryPage(
      cli,
      'fixture',
      await prepare(defaults, prefix),
      0,
    );

    expect(page.commits.map((entry) => entry.message.trim())).toEqual([
      `Upper ${prefix.toUpperCase()}`,
      `Mention ${prefix}`,
      'Initial',
    ]);
    expect(
      await subjects(
        {
          ...defaults,
          date: '24h',
          author: { kind: 'selected', identities: [bob] },
        },
        prefix,
      ),
    ).toEqual([`Upper ${prefix.toUpperCase()}`, `Mention ${prefix}`]);
    const exactCase = await readFilteredHistoryPage(
      cli,
      'fixture',
      await prepare({ ...defaults, matchCase: true }, prefix.toUpperCase()),
      0,
    );

    expect(exactCase.commits.map((entry) => entry.message.trim())).toEqual([
      `Upper ${prefix.toUpperCase()}`,
      'Initial',
    ]);
  });

  it('retains exact message whitespace and raw parents at a shallow boundary', async () => {
    const parent = head;
    const message = '\n\nÜnicode message\n\n  indented\n\n';
    const tip = await addCommit(message);

    await fixture.runGit(['update-ref', 'refs/heads/shallow-test', tip]);
    await fixture
      .runGit(['rev-parse', '--git-path', 'shallow'])
      .then(async (path) => {
        const { writeFile } = await import('node:fs/promises');

        await writeFile(join(fixture.root, path.trim()), `${tip}\n`);
      });
    const page = await readFilteredHistoryPage(
      cli,
      'fixture',
      await prepare(defaults, 'Ünicode'),
      0,
    );

    expect(page.commits).toHaveLength(1);
    expect(page.commits[0]?.message).toBe(message);
    expect(page.commits[0]?.parents).toEqual([parent]);
  });
});
