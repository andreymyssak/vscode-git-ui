import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import type { FileChange } from '../../src/shared/model';
import { selectedCommitFixture as setup } from '../fixtures/selected-commit-changes';

const sample = {
  id: 'sample',
  status: 'modified' as const,
  oldPath: 'sample.txt',
  newPath: 'sample.txt',
};

test('reverting one file preserves later edits, unchecked files and unrelated staged work without a commit', async () => {
  const f = await setup();

  await writeFile(join(f.root, 'sample.txt'), 'C\nselected\n');
  await writeFile(join(f.root, 'unchecked.txt'), 'keep source\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Source changes']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await writeFile(join(f.root, 'sample.txt'), 'later\nC\nselected\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Later edit']);
  const head = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await writeFile(join(f.root, 'unrelated.txt'), 'keep staged\n');
  await f.runGit(['add', 'unrelated.txt']);
  const staged = await f.runGit(['ls-files', '--stage', 'unrelated.txt']);
  const result = await f.operate('fixture', {
    kind: 'revert-files',
    sha,
    parentSha: f.c,
    files: [sample],
    expectedBranch: 'main',
    expectedHeadSha: head,
  });

  expect(result).toMatchObject({ kind: 'success', backend: 'api' });
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe('later\nC\n');
  expect(await readFile(join(f.root, 'unchecked.txt'), 'utf8')).toBe(
    'keep source\n',
  );
  expect(await f.runGit(['ls-files', '--stage', 'unrelated.txt'])).toBe(staged);
  expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(head);
});

test('reverting additions, renames, deletions and binary edits restores their original bytes', async () => {
  const f = await setup();
  const original = Buffer.from([0, 1, 2, 255]);

  await writeFile(join(f.root, 'old.txt'), 'rename me\n');
  await writeFile(join(f.root, 'gone.txt'), 'restore me\n');
  await writeFile(join(f.root, 'binary.bin'), original);
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'File base']);
  const base = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['mv', 'old.txt', 'new.txt']);
  await f.runGit(['rm', 'gone.txt']);
  await writeFile(join(f.root, 'binary.bin'), Buffer.from([0, 9, 8, 255]));
  await writeFile(join(f.root, 'added.txt'), 'remove me\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Selected file kinds']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();
  const files: FileChange[] = [
    { id: 'rename', status: 'renamed', oldPath: 'old.txt', newPath: 'new.txt' },
    { id: 'delete', status: 'deleted', oldPath: 'gone.txt', newPath: null },
    {
      id: 'binary',
      status: 'modified',
      oldPath: 'binary.bin',
      newPath: 'binary.bin',
    },
    { id: 'add', status: 'added', oldPath: null, newPath: 'added.txt' },
  ];
  const result = await f.operate('fixture', {
    kind: 'revert-files',
    sha,
    parentSha: base,
    files,
    expectedBranch: 'main',
    expectedHeadSha: sha,
  });

  expect(result.kind).toBe('success');
  expect(await readFile(join(f.root, 'old.txt'), 'utf8')).toBe('rename me\n');
  expect(await readFile(join(f.root, 'gone.txt'), 'utf8')).toBe('restore me\n');
  expect(await readFile(join(f.root, 'binary.bin'))).toEqual(original);
  for (const name of ['new.txt', 'added.txt'])
    await expect(readFile(join(f.root, name))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(sha);
});

test('a conflicting revert stays in native conflict stages and leaves HEAD unchanged', async () => {
  const f = await setup();

  await writeFile(join(f.root, 'sample.txt'), 'source\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Source']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await writeFile(join(f.root, 'sample.txt'), 'later\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Later']);
  const head = (await f.runGit(['rev-parse', 'HEAD'])).trim();
  const result = await f.operate('fixture', {
    kind: 'revert-files',
    sha,
    parentSha: f.c,
    files: [sample],
    expectedBranch: 'main',
    expectedHeadSha: head,
  });

  expect(result).toMatchObject({
    kind: 'conflict',
    recovery: 'source-control',
    backend: 'api',
  });
  expect(await f.runGit(['ls-files', '-u'])).toContain('sample.txt');
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toContain(
    '<<<<<<<',
  );
  expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(head);
  expect(
    await f
      .runGit(['rev-parse', '--verify', '--quiet', 'REVERT_HEAD'])
      .catch(() => ''),
  ).toBe('');
});

test.each(['working', 'staged', 'unsaved', 'head', 'cancelled'] as const)(
  'revert refuses %s changes before writing',
  async (reason) => {
    const f = await setup();

    await writeFile(join(f.root, 'sample.txt'), 'source\n');
    await f.runGit(['add', '.']);
    await f.runGit(['commit', '-m', 'Source']);
    const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

    if (reason === 'working' || reason === 'staged') {
      await writeFile(join(f.root, 'sample.txt'), 'local\n');
      if (reason === 'staged') await f.runGit(['add', '.']);
    }

    if (reason === 'unsaved')
      f.access.worktreeProtectionPaths = () => [join(f.root, 'sample.txt')];
    if (reason === 'head')
      await f.runGit(['commit', '--allow-empty', '-m', 'New head']);
    const before = await f.state();
    const controller = new AbortController();

    if (reason === 'cancelled') controller.abort();
    const result = await f.operate(
      'fixture',
      {
        kind: 'revert-files',
        sha,
        parentSha: f.c,
        files: [sample],
        expectedBranch: 'main',
        expectedHeadSha: sha,
      },
      controller.signal,
    );

    expect(result.kind).toBe(reason === 'cancelled' ? 'cancelled' : 'error');
    expect(await f.state()).toEqual(before);
  },
);

test.each(['sha1', 'sha256'] as const)(
  'selected root files revert in %s repositories',
  async (format) => {
    const f = await setup(format);

    await f.runGit(['switch', '--orphan', 'revert-root']);
    await writeFile(join(f.root, 'root.txt'), 'root\n');
    await writeFile(join(f.root, 'unchecked.txt'), 'keep\n');
    await f.runGit(['add', '.']);
    await f.runGit(['commit', '-m', 'Root']);
    const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();
    const result = await f.operate('fixture', {
      kind: 'revert-files',
      sha,
      parentSha: null,
      files: [
        { id: 'root', status: 'added', oldPath: null, newPath: 'root.txt' },
      ],
      expectedBranch: 'revert-root',
      expectedHeadSha: sha,
    });

    expect(result.kind).toBe('success');
    await expect(readFile(join(f.root, 'root.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(f.root, 'unchecked.txt'), 'utf8')).toBe(
      'keep\n',
    );
    expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(sha);
  },
);

test('a merge revert uses only the selected parent comparison', async () => {
  const f = await setup();

  await f.runGit(['switch', '-c', 'side']);
  await writeFile(join(f.root, 'side.txt'), 'side\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Side']);
  const side = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', 'main']);
  await writeFile(join(f.root, 'main.txt'), 'main\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Main']);
  await f.runGit(['merge', '--no-ff', 'side', '-m', 'Merge']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();
  const result = await f.operate('fixture', {
    kind: 'revert-files',
    sha,
    parentSha: side,
    files: [
      { id: 'main', status: 'added', oldPath: null, newPath: 'main.txt' },
    ],
    expectedBranch: 'main',
    expectedHeadSha: sha,
  });

  expect(result.kind).toBe('success');
  await expect(readFile(join(f.root, 'main.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(join(f.root, 'side.txt'), 'utf8')).toBe('side\n');
  expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(sha);
});
