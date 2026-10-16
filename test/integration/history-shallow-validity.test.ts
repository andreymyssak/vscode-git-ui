import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

import type {
  GitApiAccess,
  GitCommit,
  GitRepository,
} from '../../src/extension/git/api';
import { GitCli } from '../../src/extension/git/cli';
import { createHistoryQueries } from '../../src/extension/git/history';
import { createHistoryShallow } from '../../src/extension/git/history-shallow';
import { createRepositoryObservations } from '../../src/extension/git/repository-observations';
import {
  createSquashFixture,
  squashAccess,
} from '../fixtures/squash-repository';

async function shallowFixture() {
  const origin = await createSquashFixture();
  const directory = await mkdtemp(join(tmpdir(), 'git-ui-shallow-cache-'));
  const root = join(directory, 'clone');

  try {
    await origin.runGit([
      'clone',
      '--depth=1',
      '--single-branch',
      '--no-tags',
      pathToFileURL(origin.root).href,
      root,
    ]);
    const git = (args: string[]) => origin.runGit(args, root);
    const head = (await git(['rev-parse', 'HEAD'])).trim();
    const parse = (output: string): GitCommit[] => {
      const fields = output.split('\0');

      fields.pop();
      const records: GitCommit[] = [];

      for (let index = 0; index < fields.length; index += 3)
        records.push({
          hash: fields[index]!,
          parents: fields[index + 1]!.split(' ').filter(Boolean),
          message: fields[index + 2]!,
        });

      return records;
    };

    const access = squashAccess(root);
    const repository: GitRepository = {
      ...access.repository('fixture'),
      state: {
        HEAD: { type: 0, name: 'main', commit: head },
        refs: [],
        worktrees: [],
        remotes: [],
        mergeChanges: [],
        onDidChange: () => ({ dispose() {} }),
      },
      getRefs: async () => [{ type: 0, name: 'main', commit: head }],
      getCommit: async (ref) =>
        parse(
          await git(['log', '-1', '-z', '--format=%H%x00%P%x00%s', ref, '--']),
        )[0]!,
      log: async (options) =>
        parse(
          await git([
            'log',
            '--topo-order',
            '-z',
            '--format=%H%x00%P%x00%s',
            `--max-count=${options?.maxEntries ?? 200}`,
            `--skip=${options?.skip ?? 0}`,
            ...(options?.refNames ?? ['HEAD']),
            '--',
          ]),
        ),
    };

    access.repository = () => repository;

    return {
      access,
      git,
      root,
      head,
      async dispose() {
        await rm(directory, { recursive: true, force: true });
        await origin.dispose();
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    await origin.dispose();
    throw error;
  }
}

test('unshallow without moving tips invalidates an exhausted cached first page', async (t) => {
  const fixture = await shallowFixture();
  const reader = createHistoryQueries(
    fixture.access,
    new GitCli(fixture.access),
  );

  t.onTestFinished(async () => {
    reader.dispose();
    await fixture.dispose();
  });
  const query = { scope: { kind: 'head' as const }, text: '', cursor: null };
  const before = await reader.page('fixture', query);

  expect(before.commits).toHaveLength(1);
  expect(before.nextCursor).toBeNull();
  await fixture.git(['fetch', '--unshallow', 'origin']);
  expect((await fixture.git(['rev-parse', 'HEAD'])).trim()).toBe(fixture.head);
  const after = await reader.page('fixture', query);

  expect(after.commits).toHaveLength(4);
  expect(after.scopeId).not.toBe(before.scopeId);
});

test('linked worktrees read the shared shallow boundary and unreadable metadata cannot become a cache identity', async (t) => {
  const fixture = await shallowFixture();
  const linked = join(fixture.root, '..', 'linked');
  const shallow = createHistoryShallow(
    fixture.access,
    new GitCli(fixture.access),
  );

  t.onTestFinished(async () => {
    shallow.dispose();
    await fixture.dispose();
  });
  await fixture.git(['worktree', 'add', '--detach', linked, 'HEAD']);
  const access = squashAccess(linked);
  const other = createHistoryShallow(access, new GitCli(access));

  t.onTestFinished(() => other.dispose());
  expect(await other.path('fixture')).toBe(await shallow.path('fixture'));
  expect(await other.identity('fixture')).toBe(
    await shallow.identity('fixture'),
  );
  await writeFile(await shallow.path('fixture'), 'invalid metadata\n');
  expect(await shallow.identity('fixture')).toBeNull();
  expect(await other.identity('fixture')).toBeNull();
});

test('reopening a repository reattaches shallow observation for retained consumers', async (t) => {
  const fixture = await shallowFixture();
  const repository = fixture.access.repository('fixture');
  const id = repository.rootUri.toString();
  const opened = new Set<(repo: GitRepository) => unknown>();
  const closed = new Set<(repo: GitRepository) => unknown>();
  const access: GitApiAccess = {
    ...fixture.access,
    repository: () => repository,
    api: {
      ...fixture.access.api,
      onDidOpenRepository: (listener) => {
        opened.add(listener);

        return {
          dispose() {
            opened.delete(listener);
          },
        };
      },
      onDidCloseRepository: (listener) => {
        closed.add(listener);

        return {
          dispose() {
            closed.delete(listener);
          },
        };
      },
    },
  };
  const shallow = createHistoryShallow(access, new GitCli(access));
  const pending: Promise<void>[] = [];
  let installations = 0;
  let shallowChanged = () => {};

  let changes = 0;
  const observations = createRepositoryObservations({
    access,
    shallow,
    invalidate: (repositoryId) => shallow.invalidate(repositoryId),
    onEvent() {},
    watchShallow(repositoryId, changed) {
      const owner = new AbortController();

      pending.push(
        shallow
          .path(repositoryId, owner.signal)
          .then(() => {
            if (owner.signal.aborted) return;
            installations++;
            shallowChanged = changed;
          })
          .catch(() => {}),
      );

      return {
        dispose() {
          owner.abort();
        },
      };
    },
  });
  const subscription = observations.subscribe(id, () => changes++);

  t.onTestFinished(async () => {
    subscription.dispose();
    observations.dispose();
    shallow.dispose();
    await fixture.dispose();
  });
  await observations.settled(id);
  await Promise.all(pending);
  expect(installations).toBe(1);
  for (const listener of closed) listener(repository);
  for (const listener of opened) listener(repository);
  await observations.settled(id);
  await Promise.all(pending);
  expect(installations).toBe(2);
  await fixture.git(['fetch', '--unshallow', 'origin']);
  shallowChanged();
  await observations.settled(id);
  expect(changes).toBe(1);
});
