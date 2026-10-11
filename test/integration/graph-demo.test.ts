import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, assert, beforeAll, expect, test } from 'vitest';

import { createFixture, type Fixture } from '../fixtures/repository';

const execute = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
let other: Fixture;
let before: string;
let output: {
  root: string;
  commits: number;
  mergeCommits: number;
  updateExamples: { incoming: number; outgoing: number }[];
};

beforeAll(async () => {
  other = await createFixture({
    prefix: 'git-ui-native-demo-isolation-',
  });
  cleanup.push(() => other.dispose());
  before = (await other.runGit(['rev-parse', 'HEAD'])).trim();
  const directory = await mkdtemp(join(tmpdir(), 'git-ui-native graph-demo '));

  cleanup.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 5 }),
  );
  const { stdout } = await execute(
    process.execPath,
    [resolve('scripts/dev/create-demo.ts')],
    {
      cwd: directory,
      timeout: 75000,
      env: {
        ...process.env,
        GIT_DIR: join(other.root, '.git'),
        GIT_WORK_TREE: other.root,
        GIT_INDEX_FILE: join(other.root, '.git/index'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'alias.status',
        GIT_CONFIG_VALUE_0: '!false',
      },
    },
  );

  output = JSON.parse(stdout);
}, 90000);

afterAll(async () => {
  await Promise.all(cleanup.map((dispose) => dispose()));
});

test('tangled demo includes real two- and three-parent differences, an empty parent, and incoming-only branches', async () => {
  const git = async (...args: string[]) =>
    (await execute('git', args, { cwd: output.root })).stdout.trim();
  const revision = async (message: string) =>
    git('log', '--all', '--format=%H', `--grep=^${message}$`);
  const files = async (sha: string, index: number) =>
    (await git('diff', '--name-only', `${sha}^${index}`, sha, '--'))
      .split('\n')
      .filter(Boolean);
  const merge = await revision('UI incorporates API 4');

  expect(await files(merge, 1)).toStrictEqual(['packages/api/src/cycle-4.ts']);
  expect(await files(merge, 2)).toStrictEqual(['packages/ui/src/cycle-4.tsx']);
  const octopus = await revision('Three-parent release integration 4');

  expect(await files(octopus, 1)).toStrictEqual([
    'docs/cycle-4.md',
    'integration/cycle-4.txt',
    'packages/api/src/cycle-4.ts',
    'packages/ui/src/cycle-4.tsx',
  ]);
  expect(await files(octopus, 2)).toStrictEqual(['docs/cycle-4.md']);
  expect(await files(octopus, 3)).toStrictEqual([
    'integration/cycle-4.txt',
    'packages/api/src/cycle-4.ts',
    'packages/ui/src/cycle-4.tsx',
  ]);
  const empty = await git('rev-parse', 'examples/empty-second-parent');

  expect(await files(empty, 1)).toStrictEqual(['examples/feature.txt']);
  expect(await files(empty, 2)).toStrictEqual([]);
  expect(
    output.updateExamples.map(({ incoming, outgoing }) => [incoming, outgoing]),
  ).toStrictEqual([
    [1, 0],
    [5, 0],
    [7, 0],
    [0, 0],
  ]);
  for (const [branch, incoming] of [
    ['maintenance/behind-one', 1],
    ['maintenance/behind-five', 5],
    ['maintenance/behind-merge', 7],
    ['maintenance/up-to-date', 0],
  ] as const)
    expect(
      await git(
        'rev-list',
        '--left-right',
        '--count',
        `${branch}...${branch}@{upstream}`,
      ),
    ).toBe(`0\t${incoming}`);
  assert.ok(
    Number(
      await git(
        'rev-list',
        '--count',
        '--min-parents=2',
        'maintenance/behind-merge..maintenance/behind-merge@{upstream}',
      ),
    ) > 0,
  );
  expect(await git('status', '--porcelain')).toBe('');
});
test('the demo generator ignores inherited Git routing and leaves another repository untouched', async () => {
  expect(output.root).not.toBe(other.root);
  expect((await other.runGit(['rev-parse', 'HEAD'])).trim()).toBe(before);
  expect((await other.runGit(['status', '--porcelain'])).trim()).toBe('');
  expect(output.commits).toBe(153);
  expect(output.mergeCommits).toBe(25);
});

test('incoming maintenance keeps every revision, parent, author and timestamp', async () => {
  const git = async (...args: string[]) =>
    (await execute('git', args, { cwd: output.root })).stdout.trim();
  const lines = (
    await git(
      'log',
      '--reverse',
      '--format=%H%x00%P%x00%at%x00%s%x00%an%x00%ae',
      'main..origin/main',
    )
  ).split('\n');

  expect(lines).toHaveLength(105);
  let previous = await git('rev-parse', 'main');
  let previousTime: number | undefined;

  for (const [index, line] of lines.entries()) {
    const [sha, parent, timestamp, message, author, email] = line.split('\0');
    const time = Number(timestamp);

    assert.ok(sha);
    expect(parent).toBe(previous);
    expect(message).toBe(`Incoming maintenance ${index + 1}`);
    expect(author).toBe('John Smith');
    expect(email).toBe('john.smith@example.test');
    expect(Number.isInteger(time)).toBe(true);
    if (previousTime !== undefined) expect(time).toBe(previousTime + 60);
    previous = sha;
    previousTime = time;
  }

  expect(await git('show', 'origin/main~104:maintenance.txt')).toBe(
    'Maintenance revision 1',
  );
  expect(await git('show', 'origin/main:maintenance.txt')).toBe(
    'Maintenance revision 105',
  );
});
