import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assert, expect, test } from 'vitest';

import {
  deleteStashFiles,
  renameStash,
} from '../../src/extension/git/edit-stash';
import { readStashes, readStashFiles } from '../../src/extension/git/stashes';
import { createSquashFixture } from '../fixtures/squash-repository';

test('renaming an older stash keeps its position, date, snapshots and other stashes', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(f.dispose);
  await writeFile(join(f.root, 'sample.txt'), 'older changes\n');
  await f.runGit(['stash', 'push', '-m', 'Old name']);
  await writeFile(join(f.root, 'sample.txt'), 'newer changes\n');
  await f.runGit(['stash', 'push', '-m', 'Newer']);
  const before = await readStashes(f.cli, 'fixture');
  const older = before[1];

  assert.ok(older);
  const tree = await f.runGit(['rev-parse', `${older.sha}^{tree}`]);
  const local = await f.state();

  const renamedSha = await renameStash(
    f.cli,
    'fixture',
    older.sha,
    'Renamed ü stash',
  );
  const after = await readStashes(f.cli, 'fixture');
  const renamed = after[1];

  assert.ok(renamed);
  expect(renamedSha).toBe(renamed.sha);
  expect(after).toHaveLength(2);
  expect(after[0]).toEqual(before[0]);
  expect(renamed.message).toBe('Renamed ü stash');
  expect(renamed.date).toBe(older.date);
  expect(renamed.selector).toBe(older.selector);
  expect(await f.runGit(['rev-parse', `${renamed.sha}^{tree}`])).toBe(tree);
  expect(await f.runGit(['show', '-s', '--format=%s', renamed.sha])).toBe(
    'Renamed ü stash\n',
  );
  const afterLocal = await f.state();

  expect(afterLocal.head).toBe(local.head);
  expect(afterLocal.index).toBe(local.index);
});

test('deleting saved files preserves other snapshots, local changes and stash order', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(f.dispose);
  await writeFile(join(f.root, 'sample.txt'), 'staged\n');
  await f.runGit(['add', 'sample.txt']);
  await writeFile(join(f.root, 'sample.txt'), 'working\n');
  await writeFile(join(f.root, 'keep.bin'), Buffer.from([0, 7, 255]));
  await writeFile(join(f.root, 'remove[1].txt'), 'new file\n');
  await f.runGit(['stash', 'push', '-u', '-m', 'Saved']);
  const stash = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(stash);
  const files = await readStashFiles(f.cli, 'fixture', stash);

  await writeFile(join(f.root, 'sample.txt'), 'another stash\n');
  await f.runGit(['stash', 'push', '-m', 'Newer']);
  await writeFile(join(f.root, 'local.txt'), 'local staged\n');
  await f.runGit(['add', 'local.txt']);
  await writeFile(join(f.root, 'sample.txt'), 'local working\n');
  const index = await f.runGit(['ls-files', '--stage', '-z']);
  const newer = (await readStashes(f.cli, 'fixture'))[0];

  const editedSha = await deleteStashFiles(
    f.cli,
    'fixture',
    stash.sha,
    files.filter((file) => file.path !== 'keep.bin'),
  );
  const remaining = await readStashes(f.cli, 'fixture');
  const edited = remaining[1];

  assert.ok(edited);
  expect(editedSha).toBe(edited.sha);
  expect(remaining).toHaveLength(2);
  expect(remaining[0]).toEqual(newer);
  expect(edited.message).toBe(stash.message);
  expect(edited.date).toBe(stash.date);
  expect(await readStashFiles(f.cli, 'fixture', edited)).toEqual([
    expect.objectContaining({ path: 'keep.bin', snapshot: 'untracked' }),
  ]);
  expect(
    (
      await f.runGit(['stash', 'show', '-u', '--name-only', edited.selector])
    ).trim(),
  ).toBe('keep.bin');
  expect(await f.runGit(['ls-files', '--stage', '-z'])).toBe(index);
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe(
    'local working\n',
  );
  expect(await f.runGit(['show', `${edited.sha}^3:keep.bin`])).toBe(
    Buffer.from([0, 7, 255]).toString(),
  );
});

test('deleting a saved rename removes both paths and deleting the final file removes the stash', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(f.dispose);
  await rename(join(f.root, 'sample.txt'), join(f.root, 'renamed.txt'));
  await f.runGit(['add', '-A']);
  await f.runGit(['stash', 'push', '-m', 'Rename']);
  const stash = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(stash);
  const deletedSha = await deleteStashFiles(
    f.cli,
    'fixture',
    stash.sha,
    await readStashFiles(f.cli, 'fixture', stash),
  );

  expect(deletedSha).toBeNull();
  expect(await readStashes(f.cli, 'fixture')).toEqual([]);
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe('C\n');
});

test('stash edits refuse invalid names, forged file selections and existing Git locks', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(f.dispose);
  await writeFile(join(f.root, 'sample.txt'), 'saved\n');
  await f.runGit(['stash', 'push', '-m', 'Saved']);
  const stash = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(stash);
  const files = await readStashFiles(f.cli, 'fixture', stash);
  const file = files[0];

  assert.ok(file);
  await expect(
    renameStash(f.cli, 'fixture', stash.sha, 'invalid\nname'),
  ).rejects.toThrow();
  await expect(
    deleteStashFiles(f.cli, 'fixture', stash.sha, [
      { ...file, path: 'forged.txt' },
    ]),
  ).rejects.toThrow();
  await writeFile(join(f.root, '.git', 'refs', 'stash.lock'), 'other process');
  await expect(
    renameStash(f.cli, 'fixture', stash.sha, 'Rename'),
  ).rejects.toThrow('lock');
  expect(await readStashes(f.cli, 'fixture')).toEqual([stash]);
  expect(
    await readFile(join(f.root, '.git', 'refs', 'stash.lock'), 'utf8'),
  ).toBe('other process');
});

test('partial deletion refuses filenames that cannot round-trip through the view', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(f.dispose);
  const makeTree = async (contents: string, modifiedSample = false) => {
    const blob = (
      await f.cli.runWithInput(
        'fixture',
        ['hash-object', '-w', '--stdin'],
        contents,
      )
    ).trim();
    const sample = modifiedSample
      ? (
          await f.cli.runWithInput(
            'fixture',
            ['hash-object', '-w', '--stdin'],
            'keep me\n',
          )
        ).trim()
      : (await f.runGit(['rev-parse', `${f.c}:sample.txt`])).trim();

    return (
      await f.cli.runWithInput(
        'fixture',
        ['mktree', '-z'],
        Buffer.concat([
          Buffer.from(`100644 blob ${blob}\tbad-`),
          Buffer.from([0xff, 0]),
          Buffer.from(`100644 blob ${sample}\tsample.txt\0`),
        ]),
      )
    ).trim();
  };

  const baseTree = await makeTree('base\n');
  const base = (
    await f.runGit(['commit-tree', baseTree, '-p', f.c, '-m', 'Base'])
  ).trim();
  const index = (
    await f.runGit(['commit-tree', baseTree, '-p', base, '-m', 'Index'])
  ).trim();
  const tree = await makeTree('saved\n', true);
  const sha = (
    await f.runGit([
      'commit-tree',
      tree,
      '-p',
      base,
      '-p',
      index,
      '-m',
      'Saved',
    ])
  ).trim();

  await f.runGit(['stash', 'store', '-m', 'Saved', sha]);
  const stash = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(stash);
  const files = await readStashFiles(f.cli, 'fixture', stash);
  const before = await readFile(join(f.root, '.git', 'logs', 'refs', 'stash'));

  await expect(
    deleteStashFiles(
      f.cli,
      'fixture',
      sha,
      files.filter((file) => file.path !== 'sample.txt'),
    ),
  ).rejects.toThrow('filename');
  expect(await readStashes(f.cli, 'fixture')).toEqual([stash]);
  expect(await readFile(join(f.root, '.git', 'logs', 'refs', 'stash'))).toEqual(
    before,
  );
});

test('renaming refuses an object identity already used by another saved entry', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(f.dispose);
  await writeFile(join(f.root, 'sample.txt'), 'saved\n');
  await f.runGit(['stash', 'push', '-m', 'A']);
  const original = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(original);
  // Use identical metadata and snapshots, so only the name distinguishes the commits.
  const raw = await f.cli.runBytes('fixture', [
    'cat-file',
    'commit',
    original.sha,
  ]);
  const header = raw.subarray(0, raw.indexOf('\n\n') + 2);
  const first = (
    await f.cli.runWithInput(
      'fixture',
      ['hash-object', '-w', '-t', 'commit', '--stdin'],
      Buffer.concat([header, Buffer.from('A\n')]),
    )
  ).trim();
  const second = (
    await f.cli.runWithInput(
      'fixture',
      ['hash-object', '-w', '-t', 'commit', '--stdin'],
      Buffer.concat([header, Buffer.from('B\n')]),
    )
  ).trim();

  await f.runGit(['stash', 'drop']);
  await f.runGit(['stash', 'store', '-m', 'A', first]);
  await f.runGit(['stash', 'store', '-m', 'B', second]);
  const before = await readStashes(f.cli, 'fixture');

  await expect(renameStash(f.cli, 'fixture', second, 'A')).rejects.toThrow(
    'identical',
  );
  expect(await readStashes(f.cli, 'fixture')).toEqual(before);
});

test('partial deletion refuses restoring a base file over an unselected saved directory', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(f.dispose);
  await f.runGit(['rm', 'sample.txt']);
  await mkdir(join(f.root, 'sample.txt'));
  await writeFile(join(f.root, 'sample.txt', 'child.txt'), 'saved child\n');
  await f.runGit(['add', '-A']);
  await f.runGit(['stash', 'push', '-m', 'Directory replacement']);
  const stash = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(stash);
  const files = await readStashFiles(f.cli, 'fixture', stash);
  const selected = files.filter((file) => file.path === 'sample.txt');

  expect(selected.length).toBeGreaterThan(0);
  await expect(
    deleteStashFiles(f.cli, 'fixture', stash.sha, selected),
  ).rejects.toThrow('directory');
  expect(await readStashes(f.cli, 'fixture')).toEqual([stash]);
  expect(await readStashFiles(f.cli, 'fixture', stash)).toEqual(files);
});

test('partial deletion refuses a file/directory conflict between tracked and untracked snapshots', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(f.dispose);
  await f.runGit(['rm', 'sample.txt']);
  await mkdir(join(f.root, 'sample.txt'));
  await writeFile(join(f.root, 'sample.txt', 'child.txt'), 'saved child\n');
  await writeFile(join(f.root, 'keep.txt'), 'retain this\n');
  await f.runGit(['stash', 'push', '-u', '-m', 'Untracked replacement']);
  const stash = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(stash);
  const files = await readStashFiles(f.cli, 'fixture', stash);

  await expect(
    deleteStashFiles(
      f.cli,
      'fixture',
      stash.sha,
      files.filter((file) => file.path === 'sample.txt'),
    ),
  ).rejects.toThrow('directory');
  expect(await readStashes(f.cli, 'fixture')).toEqual([stash]);
  expect(await readStashFiles(f.cli, 'fixture', stash)).toEqual(files);
  await f.runGit(['stash', 'apply', stash.selector]);
  expect(await readFile(join(f.root, 'sample.txt', 'child.txt'), 'utf8')).toBe(
    'saved child\n',
  );
});

test('deleting an unrelated saved file leaves an unstaged file-to-directory replacement unchanged', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(f.dispose);
  await rm(join(f.root, 'sample.txt'));
  await mkdir(join(f.root, 'sample.txt'));
  await writeFile(join(f.root, 'sample.txt', 'child.txt'), 'saved child\n');
  await writeFile(join(f.root, 'remove.txt'), 'remove only this\n');
  await f.runGit(['stash', 'push', '-u', '-m', 'Unstaged replacement']);
  const stash = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(stash);
  const files = await readStashFiles(f.cli, 'fixture', stash);
  const workingTree = await f.runGit(['rev-parse', `${stash.sha}^{tree}`]);
  const indexTree = await f.runGit(['rev-parse', `${stash.sha}^2^{tree}`]);

  await deleteStashFiles(
    f.cli,
    'fixture',
    stash.sha,
    files.filter((file) => file.path === 'remove.txt'),
  );
  const remaining = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(remaining);
  expect(await f.runGit(['rev-parse', `${remaining.sha}^{tree}`])).toBe(
    workingTree,
  );
  expect(await f.runGit(['rev-parse', `${remaining.sha}^2^{tree}`])).toBe(
    indexTree,
  );
  const metadata = (file: (typeof files)[number]) => ({
    path: file.path,
    originalPath: file.originalPath,
    status: file.status,
    snapshot: file.snapshot,
  });

  expect(
    (await readStashFiles(f.cli, 'fixture', remaining)).map(metadata),
  ).toEqual(files.filter((file) => file.path !== 'remove.txt').map(metadata));
  expect(
    await f.runGit(['show', `${remaining.sha}^3:sample.txt/child.txt`]),
  ).toBe('saved child\n');
});
