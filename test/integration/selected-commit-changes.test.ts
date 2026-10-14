import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import type { FileChange } from '../../src/shared/model';
import { selectedCommitFixture as setup } from '../fixtures/selected-commit-changes';

test('selected file changes preserve target edits, unchecked files and unrelated staged work without committing', async () => {
  const f = await setup();

  await f.runGit(['switch', '-c', 'source']);
  await writeFile(join(f.root, 'sample.txt'), 'C\nselected\n');
  await writeFile(join(f.root, 'unchecked.txt'), 'do not apply\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Source changes']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', 'main']);
  await writeFile(join(f.root, 'sample.txt'), 'target\nC\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Target changes']);
  const head = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await writeFile(join(f.root, 'unrelated.txt'), 'staged\n');
  await f.runGit(['add', 'unrelated.txt']);
  const staged = await f.runGit(['ls-files', '--stage', 'unrelated.txt']);
  const result = await f.operate('fixture', {
    kind: 'cherry-pick-files',
    sha,
    parentSha: f.c,
    expectedHeadSha: head,
    expectedBranch: 'main',
    files: [
      {
        id: 'sample',
        status: 'modified',
        oldPath: 'sample.txt',
        newPath: 'sample.txt',
      },
    ],
  });

  expect(result.kind).toBe('success');
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe(
    'target\nC\nselected\n',
  );
  expect(await f.runGit(['ls-files', 'unchecked.txt'])).toBe('');
  expect(await f.runGit(['ls-files', '--stage', 'unrelated.txt'])).toBe(staged);
  expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(head);
});

test('selected additions, renames, deletions and legacy text retain their original bytes', async () => {
  const f = await setup();

  await writeFile(join(f.root, 'old.txt'), 'rename me\n');
  await writeFile(join(f.root, 'gone.txt'), 'delete me\n');
  await writeFile(join(f.root, 'legacy.txt'), Buffer.from([0xe9, 0x0a]));
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'File base']);
  const base = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', '-c', 'source']);
  await f.runGit(['mv', 'old.txt', 'new.txt']);
  await f.runGit(['rm', 'gone.txt']);
  const legacy = Buffer.from([0xe9, 0xe8, 0x0a]);
  const binary = Buffer.from([0, 1, 2, 255]);

  await writeFile(join(f.root, 'legacy.txt'), legacy);
  await writeFile(join(f.root, 'added.bin'), binary);
  await writeFile(join(f.root, 'unchecked.txt'), 'leave out\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Selected file kinds']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', 'main']);
  const files: FileChange[] = [
    { id: 'rename', status: 'renamed', oldPath: 'old.txt', newPath: 'new.txt' },
    { id: 'delete', status: 'deleted', oldPath: 'gone.txt', newPath: null },
    {
      id: 'legacy',
      status: 'modified',
      oldPath: 'legacy.txt',
      newPath: 'legacy.txt',
    },
    { id: 'binary', status: 'added', oldPath: null, newPath: 'added.bin' },
  ];
  const result = await f.operate('fixture', {
    kind: 'cherry-pick-files',
    sha,
    parentSha: base,
    files,
    expectedBranch: 'main',
    expectedHeadSha: base,
  });

  expect(result.kind).toBe('success');
  expect(await readFile(join(f.root, 'new.txt'), 'utf8')).toBe('rename me\n');
  await expect(readFile(join(f.root, 'old.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(readFile(join(f.root, 'gone.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(readFile(join(f.root, 'unchecked.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(join(f.root, 'legacy.txt'))).toEqual(legacy);
  expect(await readFile(join(f.root, 'added.bin'))).toEqual(binary);
  expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(base);
});

test.each([
  'working',
  'staged',
  'unsaved',
  'head',
  'parent',
  'outside',
  'cancelled',
] as const)(
  'selected changes reject %s target changes without mutating files or history',
  async (reason) => {
    const f = await setup();

    await f.runGit(['switch', '-c', 'source']);
    await writeFile(join(f.root, 'sample.txt'), 'source\n');
    await f.runGit(['add', 'sample.txt']);
    await f.runGit(['commit', '-m', 'Source']);
    const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

    await f.runGit(['switch', 'main']);
    if (reason === 'working' || reason === 'staged') {
      await writeFile(join(f.root, 'sample.txt'), 'local\n');
      if (reason === 'staged') await f.runGit(['add', 'sample.txt']);
    }

    if (reason === 'unsaved')
      f.access.worktreeProtectionPaths = () => [join(f.root, 'sample.txt')];
    if (reason === 'head')
      await f.runGit(['commit', '--allow-empty', '-m', 'New head']);
    const before = await f.state();
    const context = new AbortController();

    if (reason === 'cancelled') context.abort();
    const path = reason === 'outside' ? '../outside.txt' : 'sample.txt';
    const result = await f.operate(
      'fixture',
      {
        kind: 'cherry-pick-files',
        sha,
        parentSha: reason === 'parent' ? f.b : f.c,
        expectedHeadSha: f.c,
        expectedBranch: 'main',
        files: [
          { id: 'sample', status: 'modified', oldPath: path, newPath: path },
        ],
      },
      context.signal,
    );

    expect(result.kind).toBe(reason === 'cancelled' ? 'cancelled' : 'error');
    expect(await f.state()).toEqual(before);
  },
);

test.each(['sha1', 'sha256'] as const)(
  'root commit files apply in %s repositories without an assumed parent',
  async (format) => {
    const f = await setup(format);

    await f.runGit(['switch', '--orphan', 'source-root']);
    await writeFile(join(f.root, 'root.txt'), 'root content\n');
    await f.runGit(['add', 'root.txt']);
    await f.runGit(['commit', '-m', 'Root source']);
    const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

    await f.runGit(['switch', 'main']);
    const result = await f.operate('fixture', {
      kind: 'cherry-pick-files',
      sha,
      parentSha: null,
      files: [
        { id: 'root', status: 'added', oldPath: null, newPath: 'root.txt' },
      ],
      expectedBranch: 'main',
      expectedHeadSha: f.c,
    });

    expect(result.kind).toBe('success');
    expect(await readFile(join(f.root, 'root.txt'), 'utf8')).toBe(
      'root content\n',
    );
    expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(f.c);
  },
);

test('literal filenames do not select other files matching a pathspec pattern', async () => {
  const f = await setup();

  await f.runGit(['switch', '-c', 'source']);
  await writeFile(join(f.root, 'literal[1].txt'), 'selected\n');
  await writeFile(join(f.root, 'literal1.txt'), 'not selected\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Literal paths']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', 'main']);
  const result = await f.operate('fixture', {
    kind: 'cherry-pick-files',
    sha,
    parentSha: f.c,
    files: [
      {
        id: 'literal',
        status: 'added',
        oldPath: null,
        newPath: 'literal[1].txt',
      },
    ],
    expectedBranch: 'main',
    expectedHeadSha: f.c,
  });

  expect(result.kind).toBe('success');
  expect(await readFile(join(f.root, 'literal[1].txt'), 'utf8')).toBe(
    'selected\n',
  );
  await expect(readFile(join(f.root, 'literal1.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('a deleted file becoming a directory cannot include unselected child additions', async () => {
  const f = await setup();

  await f.runGit(['switch', '-c', 'source']);
  await f.runGit(['rm', 'sample.txt']);
  await mkdir(join(f.root, 'sample.txt'));
  await writeFile(join(f.root, 'sample.txt/child.txt'), 'not selected\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Replace file with directory']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', 'main']);
  const before = await f.state();
  const result = await f.operate('fixture', {
    kind: 'cherry-pick-files',
    sha,
    parentSha: f.c,
    files: [
      {
        id: 'deleted',
        status: 'deleted',
        oldPath: 'sample.txt',
        newPath: null,
      },
    ],
    expectedBranch: 'main',
    expectedHeadSha: f.c,
  });

  expect(result.kind).toBe('error');
  expect(await f.state()).toEqual(before);
});

test('dirty editor paths through a directory alias protect selected files', async () => {
  const f = await setup();

  await f.runGit(['switch', '-c', 'source']);
  await writeFile(join(f.root, 'sample.txt'), 'source\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Source']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', 'main']);
  const alias = join(f.directory, 'alias');

  await symlink(f.root, alias, 'junction');
  f.access.worktreeProtectionPaths = () => [join(alias, 'sample.txt')];
  const before = await f.state();
  const result = await f.operate('fixture', {
    kind: 'cherry-pick-files',
    sha,
    parentSha: f.c,
    files: [
      {
        id: 'sample',
        status: 'modified',
        oldPath: 'sample.txt',
        newPath: 'sample.txt',
      },
    ],
    expectedBranch: 'main',
    expectedHeadSha: f.c,
  });

  expect(result).toMatchObject({ kind: 'error', recovery: 'source-control' });
  expect(await f.state()).toEqual(before);
});

test.each(['repository', 'missing parent', 'relative through parent'] as const)(
  'unsaved additions through a %s alias stay protected when the disk file is absent',
  async (target) => {
    const f = await setup();

    await f.runGit(['switch', '-c', 'source']);
    await mkdir(join(f.root, 'nested'));
    await writeFile(join(f.root, 'nested/new.txt'), 'source\n');
    await f.runGit(['add', '.']);
    await f.runGit(['commit', '-m', 'Source addition']);
    const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

    await f.runGit(['switch', 'main']);
    const alias = join(f.directory, 'alias');

    if (target === 'relative through parent') {
      await mkdir(join(f.root, 'aliases'));
      await symlink(join(f.root, 'aliases'), alias, 'junction');
      await symlink(
        process.platform === 'win32' ? join(f.root, 'nested') : '../nested',
        join(alias, 'relative-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } else
      await symlink(
        target === 'repository' ? f.root : join(f.root, 'nested'),
        alias,
        'junction',
      );
    f.access.worktreeProtectionPaths = () => [
      join(
        alias,
        target === 'repository'
          ? 'nested/new.txt'
          : target === 'missing parent'
            ? 'new.txt'
            : 'relative-link/new.txt',
      ),
    ];
    const snapshot = async () =>
      Promise.all([
        f.runGit(['status', '--porcelain=v1', '--untracked-files=all']),
        f.runGit(['ls-files', '--stage']),
        f.runGit(['rev-parse', 'HEAD']),
        readFile(join(f.root, 'sample.txt')),
      ]);
    const before = await snapshot();
    const result = await f.operate('fixture', {
      kind: 'cherry-pick-files',
      sha,
      parentSha: f.c,
      files: [
        {
          id: 'new',
          status: 'added',
          oldPath: null,
          newPath: 'nested/new.txt',
        },
      ],
      expectedBranch: 'main',
      expectedHeadSha: f.c,
    });

    expect(result).toMatchObject({ kind: 'error', recovery: 'source-control' });
    expect(await snapshot()).toEqual(before);
  },
);

test('cancellation after patch preparation prevents the native write', async () => {
  const f = await setup();

  await f.runGit(['switch', '-c', 'source']);
  await writeFile(join(f.root, 'sample.txt'), 'source\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Source']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', 'main']);
  const before = await f.state();
  const context = new AbortController();
  const run = f.cli.run.bind(f.cli);

  f.cli.run = async (...args) => {
    const result = await run(...args);

    if (args[1].some((arg) => arg.startsWith('--output='))) context.abort();

    return result;
  };

  const result = await f.operate(
    'fixture',
    {
      kind: 'cherry-pick-files',
      sha,
      parentSha: f.c,
      files: [
        {
          id: 'sample',
          status: 'modified',
          oldPath: 'sample.txt',
          newPath: 'sample.txt',
        },
      ],
      expectedBranch: 'main',
      expectedHeadSha: f.c,
    },
    context.signal,
  );

  expect(result.kind).toBe('cancelled');
  expect(await f.state()).toEqual(before);
});

test('a failed native write is reported for review without trying another backend', async () => {
  const f = await setup();

  await f.runGit(['switch', '-c', 'source']);
  await writeFile(join(f.root, 'sample.txt'), 'source\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Source']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', 'main']);
  const before = await f.state();

  f.access.repository('fixture').apply = async () => {
    throw new Error('Native application failed');
  };

  const result = await f.operate('fixture', {
    kind: 'cherry-pick-files',
    sha,
    parentSha: f.c,
    files: [
      {
        id: 'sample',
        status: 'modified',
        oldPath: 'sample.txt',
        newPath: 'sample.txt',
      },
    ],
    expectedBranch: 'main',
    expectedHeadSha: f.c,
  });

  expect(result).toMatchObject({
    kind: 'error',
    backend: 'api',
    recovery: 'source-control',
  });
  expect(await f.state()).toEqual(before);
});

test('merge file selection applies the displayed parent comparison', async () => {
  const f = await setup();

  await f.runGit(['switch', '-c', 'side']);
  await writeFile(join(f.root, 'side.txt'), 'side\n');
  await f.runGit(['add', 'side.txt']);
  await f.runGit(['commit', '-m', 'Side']);
  const side = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', 'main']);
  await writeFile(join(f.root, 'main.txt'), 'main\n');
  await f.runGit(['add', 'main.txt']);
  await f.runGit(['commit', '-m', 'Main']);
  await f.runGit(['merge', '--no-ff', 'side', '-m', 'Merge']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', '-c', 'target', f.c]);
  const result = await f.operate('fixture', {
    kind: 'cherry-pick-files',
    sha,
    parentSha: side,
    files: [
      { id: 'main', status: 'added', oldPath: null, newPath: 'main.txt' },
    ],
    expectedBranch: 'target',
    expectedHeadSha: f.c,
  });

  expect(result.kind).toBe('success');
  expect(await readFile(join(f.root, 'main.txt'), 'utf8')).toBe('main\n');
  await expect(readFile(join(f.root, 'side.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(f.c);
});

test('conflicting selected changes leave native Git conflict stages and keep HEAD unchanged', async () => {
  const f = await setup();

  await f.runGit(['switch', '-c', 'source']);
  await writeFile(join(f.root, 'sample.txt'), 'source\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Source']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', 'main']);
  await writeFile(join(f.root, 'sample.txt'), 'target\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Target']);
  const head = (await f.runGit(['rev-parse', 'HEAD'])).trim();
  const result = await f.operate('fixture', {
    kind: 'cherry-pick-files',
    sha,
    parentSha: f.c,
    expectedHeadSha: head,
    expectedBranch: 'main',
    files: [
      {
        id: 'sample',
        status: 'modified',
        oldPath: 'sample.txt',
        newPath: 'sample.txt',
      },
    ],
  });

  expect(result).toMatchObject({
    kind: 'conflict',
    backend: 'api',
    recovery: 'source-control',
  });
  expect(await f.runGit(['ls-files', '-u'])).toContain('sample.txt');
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toContain(
    '<<<<<<<',
  );
  expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(head);
  expect(
    await f
      .runGit(['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'])
      .catch(() => ''),
  ).toBe('');
});
