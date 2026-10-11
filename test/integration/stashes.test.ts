import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TestContext } from 'vitest';
import { assert, expect, test } from 'vitest';

import {
  applyStash,
  deleteStash,
  restoreStashFiles,
} from '../../src/extension/git/stash-operations';
import { readStashes, readStashFiles } from '../../src/extension/git/stashes';
import { createSquashFixture } from '../fixtures/squash-repository';

const literalPath =
  process.platform === 'win32' ? 'literal[1].txt' : ':(glob)*.txt';

async function fixture(t: TestContext) {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());

  await writeFile(join(f.root, 'unchanged.txt'), 'base\n');
  await writeFile(join(f.root, 'deleted.txt'), 'remove\n');
  await writeFile(join(f.root, 'rename.txt'), 'rename content\n');
  await writeFile(join(f.root, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Stash base']);

  return f;
}

async function stashFixture(t: TestContext) {
  const f = await fixture(t);

  await writeFile(join(f.root, 'sample.txt'), 'index\n');
  await writeFile(join(f.root, 'unchanged.txt'), 'index only\n');
  await f.runGit(['add', 'sample.txt', 'unchanged.txt']);
  await writeFile(join(f.root, 'sample.txt'), 'working\n');
  await writeFile(join(f.root, 'unchanged.txt'), 'base\n');
  await rename(join(f.root, 'rename.txt'), join(f.root, 'renamed ü.txt'));
  await f.runGit(['add', 'rename.txt', 'renamed ü.txt']);
  await rm(join(f.root, 'deleted.txt'));
  await writeFile(join(f.root, 'binary.bin'), Buffer.from([0, 3, 4, 255]));
  await writeFile(join(f.root, literalPath), 'literal\n');
  await writeFile(join(f.root, 'untracked ü.txt'), 'saved new\n');
  await f.runGit(['stash', 'push', '--include-untracked', '-m', 'Saved stash']);
  const stashes = await readStashes(f.cli, 'fixture');
  const stash = stashes[0];

  assert.ok(stash);

  return { ...f, stash, files: await readStashFiles(f.cli, 'fixture', stash) };
}

test('stashes list ordinary stash identities and lazily distinguish every saved snapshot', async (t) => {
  const f = await stashFixture(t);

  expect(f.stash.sha).toMatch(/^[a-f0-9]{40}$/);
  expect(f.stash.selector).toBe('stash@{0}');
  expect(f.stash.message).toContain('Saved stash');
  expect(f.stash.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(
    f.files
      .filter((file) => file.path === 'sample.txt')
      .map((file) => file.snapshot),
  ).toEqual(['working', 'index']);
  expect(
    f.files
      .filter((file) => file.path === 'unchanged.txt')
      .map((file) => file.snapshot),
  ).toEqual(['index']);
  expect(f.files.filter((file) => file.path === 'renamed ü.txt')).toEqual([
    expect.objectContaining({
      originalPath: 'rename.txt',
      status: 'R100',
      snapshot: 'working',
    }),
  ]);
  expect(f.files.find((file) => file.path === 'deleted.txt')).toMatchObject({
    status: 'D',
    deleted: true,
  });
  expect(f.files.find((file) => file.path === literalPath)).toMatchObject({
    snapshot: 'untracked',
    oldRef: null,
  });
});

test('selected restore applies saved binary, rename, deletion and literal untracked patches and preserves index', async (t) => {
  const f = await stashFixture(t);

  await writeFile(join(f.root, 'local.txt'), 'unrelated\n');
  await f.runGit(['add', 'local.txt']);
  const index = await f.runGit(['ls-files', '--stage', '-z']);
  const selected = f.files.filter((file) => file.snapshot !== 'index');

  await restoreStashFiles(f.cli, 'fixture', f.stash.sha, selected);
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe('working\n');
  expect(await readFile(join(f.root, 'binary.bin'))).toEqual(
    Buffer.from([0, 3, 4, 255]),
  );
  expect(await readFile(join(f.root, 'renamed ü.txt'), 'utf8')).toBe(
    'rename content\n',
  );
  await expect(readFile(join(f.root, 'rename.txt'))).rejects.toThrow();
  await expect(readFile(join(f.root, 'deleted.txt'))).rejects.toThrow();
  expect(await readFile(join(f.root, literalPath), 'utf8')).toBe('literal\n');
  expect(await f.runGit(['ls-files', '--stage', '-z'])).toBe(index);
  expect(
    (await readStashes(f.cli, 'fixture')).map((stash) => stash.sha),
  ).toContain(f.stash.sha);
});

test('selected restore rejects conflicting saved versions and forged file entries without writes', async (t) => {
  const f = await stashFixture(t);
  const before = await f.state();

  await expect(
    restoreStashFiles(
      f.cli,
      'fixture',
      f.stash.sha,
      f.files.filter((file) => file.path === 'sample.txt'),
    ),
  ).rejects.toThrow(/version|snapshot/i);
  const selected = f.files.find((file) => file.path === 'sample.txt');

  assert.ok(selected);
  await expect(
    restoreStashFiles(f.cli, 'fixture', f.stash.sha, [
      { ...selected, newRef: f.c },
    ]),
  ).rejects.toThrow(/changed|select|invalid/i);
  expect(await f.state()).toEqual(before);
});

test('selected multi-file restore rejects a conflict atomically and keeps unrelated edits', async (t) => {
  const f = await stashFixture(t);

  await writeFile(join(f.root, 'sample.txt'), 'conflicting local\n');
  const before = await f.state();

  await expect(
    restoreStashFiles(
      f.cli,
      'fixture',
      f.stash.sha,
      f.files.filter((file) => file.snapshot === 'working'),
    ),
  ).rejects.toThrow();
  expect(await f.state()).toEqual(before);
});

test('restoring an untracked saved file refuses to overwrite an existing untracked file', async (t) => {
  const f = await stashFixture(t);

  await writeFile(join(f.root, 'untracked ü.txt'), 'current\n');
  const before = await f.state();

  await expect(
    restoreStashFiles(
      f.cli,
      'fixture',
      f.stash.sha,
      f.files.filter((file) => file.snapshot === 'untracked'),
    ),
  ).rejects.toThrow();
  expect(await f.state()).toEqual(before);
});

test('index-only saved version restores into the worktree without staging', async (t) => {
  const f = await stashFixture(t);
  const index = await f.runGit(['ls-files', '--stage', '-z']);

  await restoreStashFiles(
    f.cli,
    'fixture',
    f.stash.sha,
    f.files.filter((file) => file.path === 'unchanged.txt'),
  );
  expect(await readFile(join(f.root, 'unchanged.txt'), 'utf8')).toBe(
    'index only\n',
  );
  expect(await f.runGit(['ls-files', '--stage', '-z'])).toBe(index);
});

test('delete resolves shifted stash numbers and whole apply keeps the original stash', async (t) => {
  const f = await stashFixture(t);

  await writeFile(join(f.root, 'sample.txt'), 'newer\n');
  await f.runGit(['stash', 'push', '-m', 'Newer']);
  const newer = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(newer);
  await deleteStash(f.cli, 'fixture', f.stash.sha);
  expect(
    (await readStashes(f.cli, 'fixture')).map((stash) => stash.sha),
  ).toEqual([newer.sha]);
  await applyStash(f.cli, 'fixture', newer.sha);
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe('newer\n');
  expect(
    (await readStashes(f.cli, 'fixture')).map((stash) => stash.sha),
  ).toEqual([newer.sha]);
  const before = await f.state();

  await expect(applyStash(f.cli, 'fixture', f.stash.sha)).rejects.toThrow(
    /unavailable|disappeared/i,
  );
  await expect(deleteStash(f.cli, 'fixture', 'stash@{0}')).rejects.toThrow(
    /identity/i,
  );
  expect(await f.state()).toEqual(before);
});

test('no stash yields an empty list', async (t) => {
  const f = await fixture(t);

  expect(await readStashes(f.cli, 'fixture')).toEqual([]);
});

test('selected saved patch preserves unrelated edits within the same file and untouched staged changes', async (t) => {
  const f = await fixture(t);
  const base = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');

  await writeFile(join(f.root, 'sample.txt'), base);
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Many lines']);
  await writeFile(
    join(f.root, 'sample.txt'),
    base.replace('line 2\n', 'saved line\n'),
  );
  await f.runGit(['stash', 'push', '-m', 'Saved lines']);
  const stash = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(stash);
  await writeFile(
    join(f.root, 'sample.txt'),
    base.replace('line 25\n', 'staged local\n'),
  );
  await f.runGit(['add', 'sample.txt']);
  await writeFile(
    join(f.root, 'sample.txt'),
    base.replace('line 25\n', 'working local\n'),
  );
  const index = await f.runGit(['ls-files', '--stage', '-z']);

  await restoreStashFiles(
    f.cli,
    'fixture',
    stash.sha,
    await readStashFiles(f.cli, 'fixture', stash),
  );
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe(
    base
      .replace('line 2\n', 'saved line\n')
      .replace('line 25\n', 'working local\n'),
  );
  expect(await f.runGit(['ls-files', '--stage', '-z'])).toBe(index);
});

test('whole stash conflicts retain the stash without a retry', async (t) => {
  const f = await fixture(t);

  await writeFile(join(f.root, 'sample.txt'), 'saved\n');
  await f.runGit(['stash', 'push', '-m', 'Conflicting stash']);
  const stash = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(stash);
  await writeFile(join(f.root, 'sample.txt'), 'new head\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Diverged head']);
  await expect(applyStash(f.cli, 'fixture', stash.sha)).rejects.toThrow();
  expect(await f.runGit(['diff', '--name-only', '--diff-filter=U'])).toContain(
    'sample.txt',
  );
  expect(
    (await readStashes(f.cli, 'fixture')).map((item) => item.sha),
  ).toContain(stash.sha);
});

test('SHA-256 ordinary stash reads and selected untracked restore use the repository object format', async (t) => {
  const f = await createSquashFixture('sha256');

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'new.txt'), 'saved new\n');
  await f.runGit([
    'stash',
    'push',
    '--include-untracked',
    '-m',
    'SHA256 stash',
  ]);
  const stash = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(stash);
  expect(stash.sha).toHaveLength(64);
  const files = await readStashFiles(f.cli, 'fixture', stash);

  await restoreStashFiles(f.cli, 'fixture', stash.sha, files);
  expect(await readFile(join(f.root, 'new.txt'), 'utf8')).toBe('saved new\n');
  await deleteStash(f.cli, 'fixture', stash.sha);
  expect(await readStashes(f.cli, 'fixture')).toEqual([]);
});

for (const operation of ['whole', 'selected'] as const) {
  test(`${operation} stash application refuses an unfinished merge without modifying files or deleting the stash`, async (t) => {
    const f = await stashFixture(t);
    const marker = join(f.root, '.git', 'MERGE_HEAD');

    await writeFile(marker, `${f.c}\n`);
    const before = await f.state();
    const restore =
      operation === 'whole'
        ? () => applyStash(f.cli, 'fixture', f.stash.sha)
        : () =>
            restoreStashFiles(
              f.cli,
              'fixture',
              f.stash.sha,
              f.files.filter((file) => file.snapshot === 'working'),
            );

    await expect(restore()).rejects.toThrow(/finish.*merge/i);
    expect(await f.state()).toEqual(before);
    expect(await readFile(marker, 'utf8')).toBe(`${f.c}\n`);
    expect(
      (await readStashes(f.cli, 'fixture')).map((stash) => stash.sha),
    ).toContain(f.stash.sha);
  });
}

test('stash application refuses an unmerged index without an operation marker', async (t) => {
  const f = await stashFixture(t);
  const path = 'unchanged.txt';
  const blob = (await f.runGit(['rev-parse', `HEAD:${path}`])).trim();

  await f.cli.runWithInput(
    'fixture',
    ['update-index', '--index-info'],
    `0 ${'0'.repeat(40)}\t${path}\n100644 ${blob} 1\t${path}\n100644 ${blob} 2\t${path}\n100644 ${blob} 3\t${path}\n`,
  );
  const before = await f.state();

  await expect(applyStash(f.cli, 'fixture', f.stash.sha)).rejects.toThrow(
    /resolve.*conflict/i,
  );
  await expect(
    restoreStashFiles(
      f.cli,
      'fixture',
      f.stash.sha,
      f.files.filter((file) => file.snapshot === 'working'),
    ),
  ).rejects.toThrow(/resolve.*conflict/i);
  expect(await f.state()).toEqual(before);
});

test('selected restore preserves exact high bytes in files Git classifies as text', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'legacy-text.txt');
  const original = Buffer.from([65, 10, 233, 10, 90, 10]);
  const saved = Buffer.from([65, 10, 241, 10, 90, 10]);

  await writeFile(path, original);
  await f.runGit(['add', 'legacy-text.txt']);
  await f.runGit(['commit', '-m', 'Legacy encoded text']);
  await writeFile(path, saved);
  await f.runGit(['stash', 'push', '-m', 'Saved legacy text']);
  const stash = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(stash);
  expect(
    await f.runGit([
      'diff',
      '--binary',
      stash.base,
      stash.sha,
      '--',
      'legacy-text.txt',
    ]),
  ).not.toContain('GIT binary patch');
  const index = await f.runGit(['ls-files', '--stage', '-z']);

  await restoreStashFiles(
    f.cli,
    'fixture',
    stash.sha,
    await readStashFiles(f.cli, 'fixture', stash),
  );
  expect(await readFile(path)).toEqual(saved);
  expect(await f.runGit(['ls-files', '--stage', '-z'])).toBe(index);
  expect(
    (await readStashes(f.cli, 'fixture')).map((item) => item.sha),
  ).toContain(stash.sha);
});
