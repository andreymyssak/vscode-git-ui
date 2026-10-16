import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, onTestFinished, test, vi } from 'vitest';

import { GitCli } from '../../src/extension/git/cli';
import { createHistoryMaintenance } from '../../src/extension/git/history-maintenance';
import { createFixture } from '../fixtures/repository';
import { squashAccess } from '../fixtures/squash-repository';

async function fixture() {
  const repository = await createFixture({ prefix: 'git-ui-history-cache ü ' });
  const access = squashAccess(repository.root);
  const cli = new GitCli(access);
  let task: (() => Promise<void>) | undefined;

  vi.stubEnv('GIT_CONFIG_GLOBAL', join(repository.root, 'isolated-gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  const maintenance = createHistoryMaintenance({
    access,
    cli,
    isEnabled: () => true,
    isTrusted: () => true,
    schedule(run) {
      task = run;

      return {
        dispose: () => {
          task = undefined;
        },
      };
    },
  });

  onTestFinished(async () => {
    maintenance.dispose();
    vi.unstubAllEnvs();
    await repository.dispose();
  });

  return {
    ...repository,
    maintenance,
    graphDirectory: join(
      repository.root,
      '.git',
      'objects',
      'info',
      'commit-graphs',
    ),
    async maintain() {
      maintenance.request('fixture');
      const pending = task;

      task = undefined;
      await pending?.();
    },
    async state() {
      return {
        refs: await repository.runGit(['show-ref', '--head']),
        index: await readFile(join(repository.root, '.git', 'index')),
        file: await readFile(join(repository.root, 'sample.txt')),
      };
    },
  };
}

test('writes a verified split commit graph without changing refs, index or working files', async () => {
  const f = await fixture();

  await writeFile(join(f.root, 'sample.txt'), 'staged\n');
  await f.runGit(['add', 'sample.txt']);
  await writeFile(join(f.root, 'sample.txt'), 'unstaged\n');
  const before = await f.state();

  await f.maintain();
  expect(
    (await readdir(f.graphDirectory)).some((name) => name.endsWith('.graph')),
  ).toBe(true);
  expect(await f.runGit(['commit-graph', 'verify'])).toBe('');
  expect(await f.state()).toEqual(before);
});

test('disables inherited Bloom generation even when an existing graph has changed-path filters', async () => {
  const f = await fixture();

  await f.runGit(['config', 'commitGraph.changedPaths', 'true']);
  await f.runGit([
    'commit-graph',
    'write',
    '--reachable',
    '--split',
    '--changed-paths',
  ]);
  await writeFile(join(f.root, 'sample.txt'), 'second\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Second']);
  await f.maintain();
  const chain = (
    await readFile(join(f.graphDirectory, 'commit-graph-chain'), 'utf8')
  )
    .trim()
    .split('\n');

  for (const hash of chain) {
    const graph = await readFile(join(f.graphDirectory, `graph-${hash}.graph`));

    // Four-byte chunk IDs in the graph's table, not commit data or object IDs.
    const chunks = Array.from({ length: graph[6] ?? 0 }, (_, index) =>
      graph.toString('ascii', 8 + index * 12, 12 + index * 12),
    );

    expect(chunks).not.toContain('BIDX');
    expect(chunks).not.toContain('BDAT');
  }

  expect(
    await f.runGit(['config', '--bool', '--get', 'commitGraph.changedPaths']),
  ).toBe('true\n');
  expect(await f.runGit(['commit-graph', 'verify'])).toBe('');
});

test.each(['disabled', 'shallow', 'partial', 'promisor', 'pack'] as const)(
  'real %s repositories create no graph',
  async (reason) => {
    const f = await fixture();

    if (reason === 'disabled')
      await f.runGit(['config', 'core.commitGraph', 'false']);
    if (reason === 'shallow')
      await writeFile(
        join(f.root, '.git', 'shallow'),
        (await f.runGit(['rev-parse', 'HEAD'])).trim() + '\n',
      );
    if (reason === 'partial') {
      await f.runGit(['config', 'core.repositoryFormatVersion', '1']);
      await f.runGit(['config', 'extensions.partialClone', 'origin']);
    }

    if (reason === 'promisor')
      await f.runGit(['config', 'remote.origin.promisor', 'true']);
    if (reason === 'pack')
      await writeFile(
        join(f.root, '.git', 'objects', 'pack', 'pack-fixture.promisor'),
        '',
      );
    const before = await f.state();

    await f.maintain();
    await expect(readdir(f.graphDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await f.state()).toEqual(before);
  },
);

test('an existing commit-graph lock is retained and its failure stays detached', async () => {
  const f = await fixture();
  const lock = join(f.graphDirectory, 'commit-graph-chain.lock');

  await mkdir(f.graphDirectory);
  await writeFile(lock, 'owned elsewhere\n');
  const before = await f.state();

  await expect(f.maintain()).resolves.toBeUndefined();
  expect(await readFile(lock, 'utf8')).toBe('owned elsewhere\n');
  await expect(
    readFile(join(f.graphDirectory, 'commit-graph-chain')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await f.state()).toEqual(before);
});

test('a linked worktree shares the common-directory throttle and writes no private cache', async () => {
  const f = await fixture();
  const linkedRoot = join(f.root, 'linked');

  await f.runGit(['worktree', 'add', '--detach', linkedRoot, 'HEAD']);
  await f.maintain();
  const linkedAccess = squashAccess(linkedRoot);
  const linkedCli = new GitCli(linkedAccess);
  let task: (() => Promise<void>) | undefined;
  const commands: string[][] = [];
  const linked = createHistoryMaintenance({
    access: linkedAccess,
    cli: {
      run(id, args, signal, beforeExecute) {
        commands.push([...args]);

        return linkedCli.run(id, args, signal, beforeExecute);
      },
      stream(id, args, consume, signal, input, beforeExecute) {
        commands.push([...args]);

        return linkedCli.stream(
          id,
          args,
          consume,
          signal,
          input,
          beforeExecute,
        );
      },
    },
    isEnabled: () => true,
    isTrusted: () => true,
    schedule(run) {
      task = run;

      return {
        dispose: () => {
          task = undefined;
        },
      };
    },
  });

  onTestFinished(async () => {
    linked.dispose();
  });
  linked.request('fixture');
  await task?.();
  expect(commands.some((args) => args[0] === 'commit-graph')).toBe(false);
  expect(await f.runGit(['commit-graph', 'verify'])).toBe('');
  await expect(
    readdir(join(f.root, '.git', 'worktrees', 'linked', 'objects')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test.skipIf(process.platform === 'win32')(
  'a read-only objects directory leaves history and repository files usable',
  async () => {
    const f = await fixture();
    const info = join(f.root, '.git', 'objects', 'info');
    const before = await f.state();

    await chmod(info, 0o555);
    try {
      await expect(f.maintain()).resolves.toBeUndefined();
      await expect(readdir(f.graphDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await f.runGit(['log', '-1', '--format=%s'])).toBe('Initial\n');
      expect(await f.state()).toEqual(before);
    } finally {
      await chmod(info, 0o755);
    }
  },
);
