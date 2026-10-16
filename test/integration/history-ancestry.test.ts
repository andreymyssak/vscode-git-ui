import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, vi } from 'vitest';

import type { GitCommit, GitRepository } from '../../src/extension/git/api';
import { GitCli } from '../../src/extension/git/cli';
import { createHistoryQueries } from '../../src/extension/git/history';
import { createHistoryAnnotations } from '../../src/extension/git/history-annotations';
import type { CommitRecord, HistoryInput } from '../../src/shared/model';
import { commitLinearHistory, createFixture } from '../fixtures/repository';
import {
  createSquashFixture,
  squashAccess,
} from '../fixtures/squash-repository';

const records = (...shas: string[]): CommitRecord[] =>
  shas.map((sha) => ({
    sha,
    parents: [],
    message: 'Requested commit',
    authorName: null,
    authorEmail: null,
    authorDate: null,
    commitDate: null,
  }));

async function linearFixture(count: number) {
  const fixture = await createFixture({ prefix: 'git-ui ancestry ' });

  try {
    const base = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    const head = await commitLinearHistory(
      fixture,
      base,
      Array.from({ length: count }, (_, index) => ({
        message: `Main ${index + 1}`,
        date: `${1700000000 + index} +0000`,
      })),
    );

    await fixture.runGit(['update-ref', 'refs/heads/main', head]);

    return {
      ...fixture,
      base,
      head,
      access: squashAccess(fixture.root),
      async ancestor(distance: number) {
        return (
          await fixture.runGit(['rev-parse', `${head}~${distance}`])
        ).trim();
      },
    };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

test('a late deep-page subscriber cannot miss an ancestor already passed by a shared Git walk', async () => {
  const f = await linearFixture(6500);
  const deep = await f.ancestor(6400);
  const passed = await f.ancestor(4500);
  const reader = createHistoryAnnotations(new GitCli(f.access));
  const original = GitCli.prototype.stream;
  let late: Promise<string[]> | undefined;
  let seen = 0;
  const input = {
    snapshot: Symbol(),
    repositoryId: 'fixture',
    head: f.head,
    tips: [f.head, f.base],
  };
  const streamed = vi
    .spyOn(GitCli.prototype, 'stream')
    .mockImplementation(function (
      this: GitCli,
      id,
      args,
      consume,
      signal,
      stdin,
      before,
    ) {
      let pending = '';

      return original.call(
        this,
        id,
        args,
        (chunk) => {
          pending += chunk.toString('utf8');
          for (
            let end = pending.indexOf('\n');
            end !== -1;
            end = pending.indexOf('\n')
          ) {
            const line = pending.slice(0, end + 1);

            pending = pending.slice(end + 1);
            if (!consume(Buffer.from(line))) return false;
            if (++seen === 5001)
              late = reader.read({ ...input, commits: records(passed) });
          }

          return true;
        },
        signal,
        stdin,
        before,
      );
    });

  try {
    await expect(
      reader.read({ ...input, commits: records(deep) }),
    ).resolves.toEqual([deep]);
    if (!late)
      throw new Error(
        'The real ancestry walk never reached the late subscription.',
      );
    await expect(late).resolves.toEqual([passed]);
  } finally {
    reader.dispose();
    streamed.mockRestore();
    await f.dispose();
  }
});

test('multi-tip pages share real ancestry and distinguish both merge parents from an unmerged tip', async () => {
  const f = await createSquashFixture();
  const tree = (await f.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
  const side = (
    await f.runGit(['commit-tree', tree, '-p', f.a, '-m', 'Side parent'])
  ).trim();
  const unmerged = (
    await f.runGit(['commit-tree', tree, '-p', f.initial, '-m', 'Other branch'])
  ).trim();
  const head = (
    await f.runGit(['commit-tree', tree, '-p', f.c, '-p', side, '-m', 'Merge'])
  ).trim();
  const reader = createHistoryAnnotations(f.cli);
  const streamed = vi.spyOn(GitCli.prototype, 'stream');
  const input = {
    snapshot: Symbol(),
    repositoryId: 'fixture',
    head,
    tips: [head, unmerged],
  };

  try {
    const first = reader.read({
      ...input,
      commits: records(unmerged, side, f.b),
    });
    const second = reader.read({
      ...input,
      commits: records(head, f.initial, f.a),
    });

    await expect(first).resolves.toEqual([side, f.b]);
    await expect(second).resolves.toEqual([head, f.initial, f.a]);
    await expect(
      reader.read({ ...input, commits: records(unmerged, f.b) }),
    ).resolves.toEqual([f.b]);
    expect(
      streamed.mock.calls.filter(([, args]) => args[0] === 'rev-list'),
    ).toHaveLength(1);
  } finally {
    reader.dispose();
    streamed.mockRestore();
    await f.dispose();
  }
});

test('a deep real walk retains nearby pages and reruns for an uncached ancestor outside its bounded prefix', async () => {
  const f = await linearFixture(6500);
  const deep = await f.ancestor(6400);
  const nearby = await f.ancestor(250);
  const uncached = await f.ancestor(4500);
  const reader = createHistoryAnnotations(new GitCli(f.access));
  const streamed = vi.spyOn(GitCli.prototype, 'stream');
  const input = {
    snapshot: Symbol(),
    repositoryId: 'fixture',
    head: f.head,
    tips: [f.head, f.base],
  };
  const walks = () =>
    streamed.mock.calls.filter(([, args]) => args[0] === 'rev-list').length;

  try {
    await expect(
      reader.read({ ...input, commits: records(deep) }),
    ).resolves.toEqual([deep]);
    await expect(
      reader.read({ ...input, commits: records(nearby) }),
    ).resolves.toEqual([nearby]);
    expect(walks()).toBe(1);
    await expect(
      reader.read({ ...input, commits: records(uncached) }),
    ).resolves.toEqual([uncached]);
    expect(walks()).toBe(2);
  } finally {
    reader.dispose();
    streamed.mockRestore();
    await f.dispose();
  }
});

test('changing HEAD recomputes membership even when the displayed tips and commits stay the same', async () => {
  const f = await createSquashFixture();
  const reader = createHistoryAnnotations(f.cli);
  const streamed = vi.spyOn(GitCli.prototype, 'stream');
  const input = {
    snapshot: Symbol(),
    repositoryId: 'fixture',
    tips: [f.c, f.b],
    commits: records(f.c, f.b, f.a),
  };

  try {
    await expect(reader.read({ ...input, head: f.c })).resolves.toEqual([
      f.c,
      f.b,
      f.a,
    ]);
    await expect(reader.read({ ...input, head: f.b })).resolves.toEqual([
      f.b,
      f.a,
    ]);
    expect(
      streamed.mock.calls.filter(([, args]) => args[0] === 'rev-list'),
    ).toHaveLength(2);
  } finally {
    reader.dispose();
    streamed.mockRestore();
    await f.dispose();
  }
});

test('invalidation discards negative ancestry answers when a real shallow boundary grows', async () => {
  const f = await createSquashFixture();
  const reader = createHistoryAnnotations(f.cli);
  const streamed = vi.spyOn(GitCli.prototype, 'stream');
  const input = {
    snapshot: Symbol(),
    repositoryId: 'fixture',
    head: f.c,
    tips: [f.c, f.b],
    commits: records(f.b, f.initial),
  };
  const shallow = join(f.root, '.git', 'shallow');

  try {
    await writeFile(shallow, f.c + '\n');
    await expect(reader.read(input)).resolves.toEqual([]);
    await rm(shallow);
    reader.invalidate('fixture');
    await expect(reader.read(input)).resolves.toEqual([f.b, f.initial]);
    expect(
      streamed.mock.calls.filter(([, args]) => args[0] === 'rev-list'),
    ).toHaveLength(2);
  } finally {
    reader.dispose();
    streamed.mockRestore();
    await f.dispose();
  }
});

function parseNativeCommits(output: string): GitCommit[] {
  const fields = output.split('\0');
  const commits: GitCommit[] = [];

  if (fields.pop() !== '')
    throw new Error('Incomplete fixture Git log output.');
  for (let index = 0; index < fields.length; index += 3) {
    const hash = fields[index];
    const parents = fields[index + 1];
    const message = fields[index + 2];

    if (hash === undefined || parents === undefined || message === undefined)
      throw new Error('Incomplete fixture Git commit.');
    commits.push({
      hash,
      parents: parents.split(' ').filter(Boolean),
      message,
    });
  }

  return commits;
}

test('production history paging reuses one ancestry stream and invalidation starts fresh', async () => {
  const f = await linearFixture(460);
  const tree = (await f.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
  const side = (
    await f.runGit(['commit-tree', tree, '-p', f.base, '-m', 'Branch only'])
  ).trim();

  await f.runGit(['update-ref', 'refs/heads/side', side]);
  const format = '--format=%H%x00%P%x00%s';
  const repository: GitRepository = {
    ...f.access.repository('fixture'),
    state: {
      HEAD: { type: 0, name: 'main', commit: f.head },
      refs: [],
      worktrees: [],
      remotes: [],
      mergeChanges: [],
      onDidChange: () => ({ dispose() {} }),
    },
    getRefs: async () => [
      { type: 0, name: 'main', commit: f.head },
      { type: 0, name: 'side', commit: side },
    ],
    getCommit: async (ref) => {
      const [commit] = parseNativeCommits(
        await f.runGit(['log', '-1', '-z', format, ref, '--']),
      );

      if (!commit) throw new Error('The fixture commit is unavailable.');

      return commit;
    },
    log: async (options) =>
      parseNativeCommits(
        await f.runGit([
          'log',
          '--topo-order',
          '-z',
          format,
          `--skip=${options?.skip ?? 0}`,
          `--max-count=${options?.maxEntries ?? 200}`,
          ...(options?.refNames ?? []),
          '--',
        ]),
      ),
  };
  const access = { ...f.access, repository: () => ({ ...repository }) };
  const history = createHistoryQueries(access, new GitCli(access));
  const streamed = vi.spyOn(GitCli.prototype, 'stream');
  const input: HistoryInput = {
    scope: { kind: 'all' },
    text: '',
    cursor: null,
  };

  try {
    const first = await history.page('fixture', input);
    const second = await history.page('fixture', {
      ...input,
      cursor: first.nextCursor,
    });
    const third = await history.page('fixture', {
      ...input,
      cursor: second.nextCursor,
    });
    const all = [...first.commits, ...second.commits, ...third.commits];

    expect(first.commits).toHaveLength(200);
    expect(second.commits).toHaveLength(200);
    expect(third.commits).toHaveLength(62);
    expect(third.nextCursor).toBeNull();
    expect(all.map((commit) => commit.message)).toEqual([
      'Branch only',
      ...Array.from({ length: 460 }, (_, index) => `Main ${460 - index}`),
      'Initial',
    ]);
    for (const page of [first, second, third])
      expect(page.annotations?.currentBranch).toEqual(
        page.commits
          .filter((commit) => commit.sha !== side)
          .map((commit) => commit.sha),
      );
    expect(
      streamed.mock.calls.filter(([, args]) => args[0] === 'rev-list'),
    ).toHaveLength(1);
    history.invalidate('fixture');
    const reloaded = await history.page('fixture', input);

    expect(reloaded.commits).toEqual(first.commits);
    expect(reloaded.annotations?.currentBranch).toEqual(
      first.annotations?.currentBranch,
    );
    expect(
      streamed.mock.calls.filter(([, args]) => args[0] === 'rev-list'),
    ).toHaveLength(2);
  } finally {
    history.dispose();
    streamed.mockRestore();
    await f.dispose();
  }
});

test('a fresh history snapshot recomputes ancestry after unshallowing with unchanged HEAD and refs', async () => {
  const f = await createSquashFixture();
  const format = '--format=%H%x00%P%x00%s';
  const repository: GitRepository = {
    ...f.access.repository('fixture'),
    state: {
      HEAD: { type: 0, name: 'main', commit: f.c },
      refs: [],
      worktrees: [],
      remotes: [],
      mergeChanges: [],
      onDidChange: () => ({ dispose() {} }),
    },
    getRefs: async () => [
      { type: 0, name: 'main', commit: f.c },
      { type: 0, name: 'retained-branch', commit: f.a },
      { type: 2, name: 'retained-tag', commit: f.b },
    ],
    getCommit: async (ref) => {
      const [commit] = parseNativeCommits(
        await f.runGit(['log', '-1', '-z', format, ref, '--']),
      );

      if (!commit) throw new Error('The fixture commit is unavailable.');

      return commit;
    },
    log: async (options) =>
      parseNativeCommits(
        await f.runGit([
          'log',
          '--topo-order',
          '-z',
          format,
          `--skip=${options?.skip ?? 0}`,
          `--max-count=${options?.maxEntries ?? 200}`,
          ...(options?.refNames ?? []),
          '--',
        ]),
      ),
  };
  const access = { ...f.access, repository: () => ({ ...repository }) };
  let now = 0;
  const history = createHistoryQueries(access, new GitCli(access), () => now);
  const input: HistoryInput = {
    scope: { kind: 'all' },
    text: '',
    cursor: null,
  };
  const shallow = join(f.root, '.git', 'shallow');

  try {
    const refsBefore = await f.runGit(['show-ref', '--head']);

    await writeFile(shallow, f.c + '\n');
    const initial = await history.page('fixture', input);

    expect(initial.commits).toHaveLength(4);
    expect(initial.annotations?.currentBranch).toEqual([f.c]);
    await rm(shallow);
    now = 60_001;
    const fresh = await history.page('fixture', input);

    expect(await f.runGit(['show-ref', '--head'])).toBe(refsBefore);
    expect(fresh.commits.map((commit) => commit.sha)).toEqual([
      f.c,
      f.b,
      f.a,
      f.initial,
    ]);
    expect(fresh.annotations?.currentBranch).toEqual([
      f.c,
      f.b,
      f.a,
      f.initial,
    ]);
  } finally {
    history.dispose();
    await f.dispose();
  }
});
