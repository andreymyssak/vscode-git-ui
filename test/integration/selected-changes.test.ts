import {
  chmod,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { assert, expect, onTestFinished, test } from 'vitest';

import {
  captureSelection,
  commitSelected,
  stashSelected,
} from '../../src/extension/git/selected-changes';
import { readWorkingChanges } from '../../src/extension/git/working-changes';
import { createSquashFixture } from '../fixtures/squash-repository';

test.skipIf(process.platform === 'win32').each(['commit', 'stash'] as const)(
  '%s treats colons and literal backslashes as POSIX filename characters',
  async (action) => {
    const f = await createSquashFixture();

    onTestFinished(() => f.dispose());
    const paths = [
      'a:notes.txt',
      String.raw`two\\slashes.txt`,
      String.raw`..\literal.txt`,
    ];

    for (const path of paths) await writeFile(join(f.root, path), 'selected\n');
    await writeFile(join(f.root, 'sample.txt'), 'unchecked staged\n');
    await f.runGit(['add', 'sample.txt']);
    await writeFile(join(f.root, 'sample.txt'), 'unchecked working\n');
    const files = (await readWorkingChanges(f.cli, 'fixture')).filter((file) =>
      paths.includes(file.path),
    );

    expect(files.map((file) => file.path).sort()).toEqual([...paths].sort());
    const snapshot = await captureSelection(f.cli, 'fixture', files);
    const result = await (action === 'commit' ? commitSelected : stashSelected)(
      f.cli,
      'fixture',
      snapshot,
      'Literal filenames',
    );

    expect(await f.runGit(['show', ':sample.txt'])).toBe('unchecked staged\n');
    expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe(
      'unchecked working\n',
    );
    for (const path of paths) {
      expect(
        await f.runGit([
          'show',
          `${result.sha}${action === 'stash' ? '^3' : ''}:${path}`,
        ]),
      ).toBe('selected\n');
    }
  },
);

for (const action of ['commit', 'stash'] as const) {
  test(`${action} checked whole files preserves unchecked staging and literal binary/new/renamed/deleted paths`, async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    for (const name of ['unchecked', 'deleted', 'old', '[literal].bin'])
      await writeFile(join(f.root, name), 'base\n');
    await f.runGit(['add', '.']);
    await f.runGit(['commit', '-m', 'Base files']);
    const base = (await f.runGit(['rev-parse', 'HEAD'])).trim();
    const newPath =
      process.platform === 'win32' ? '[new] ü.txt' : ':new [x] ü.txt';

    await writeFile(join(f.root, 'unchecked'), 'unchecked staged\n');
    await writeFile(join(f.root, 'sample.txt'), 'selected staged\n');
    await f.runGit(['add', '.']);
    await writeFile(join(f.root, 'unchecked'), 'unchecked working\n');
    await writeFile(join(f.root, 'sample.txt'), 'selected working\n');
    await writeFile(join(f.root, newPath), 'new\n');
    const bytes = Buffer.from([0, 255, 254, 12, 1]);

    await writeFile(join(f.root, '[literal].bin'), bytes);
    await rm(join(f.root, 'deleted'));
    await rename(join(f.root, 'old'), join(f.root, 'renamed'));
    await f.runGit(['add', '--', 'old', 'renamed']);
    const unchecked = await f.runGit([
      'ls-files',
      '--stage',
      '--',
      'unchecked',
    ]);
    const files = (await readWorkingChanges(f.cli, 'fixture')).filter(
      (file) => file.path !== 'unchecked',
    );

    expect(files.find((file) => file.path === 'renamed')?.originalPath).toBe(
      'old',
    );
    const snapshot = await captureSelection(f.cli, 'fixture', files);
    const result = await (action === 'commit' ? commitSelected : stashSelected)(
      f.cli,
      'fixture',
      snapshot,
      'Checked files',
    );

    expect(await f.runGit(['ls-files', '--stage', '--', 'unchecked'])).toBe(
      unchecked,
    );
    expect(await readFile(join(f.root, 'unchecked'), 'utf8')).toBe(
      'unchecked working\n',
    );
    if (action === 'commit') {
      expect(await f.runGit(['show', `${result.sha}:sample.txt`])).toBe(
        'selected working\n',
      );
      expect(await f.runGit(['show', `${result.sha}:unchecked`])).toBe(
        'base\n',
      );
      expect(await f.runGit(['show', `${result.sha}:${newPath}`])).toBe(
        'new\n',
      );
      expect(await f.runGit(['diff', '--name-only', '--cached'])).toBe(
        'unchecked\n',
      );
    } else {
      expect(await f.runGit(['show', `${result.sha}^2:sample.txt`])).toBe(
        'selected staged\n',
      );
      expect(await f.runGit(['show', `${result.sha}:unchecked`])).toBe(
        'base\n',
      );
      expect(await f.runGit(['show', `${result.sha}^2:unchecked`])).toBe(
        'base\n',
      );
      expect(await f.runGit(['rev-parse', 'HEAD'])).toBe(`${base}\n`);
      expect(
        (await readWorkingChanges(f.cli, 'fixture')).map((file) => file.path),
      ).toEqual(['unchecked']);
      await f.runGit(['reset', '--hard', 'HEAD']);
      await f.runGit(['stash', 'apply', result.sha]);
      expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe(
        'selected working\n',
      );
      expect(await readFile(join(f.root, '[literal].bin'))).toEqual(bytes);
      expect(await readFile(join(f.root, 'unchecked'), 'utf8')).toBe('base\n');
      expect(await readFile(join(f.root, newPath), 'utf8')).toBe('new\n');
    }
  });
  for (const change of ['content', 'index', 'head', 'operation'] as const) {
    test(`${action} refuses a changed ${change} after selection without additional writes`, async (t) => {
      const f = await createSquashFixture();

      t.onTestFinished(() => f.dispose());
      await writeFile(join(f.root, 'sample.txt'), 'selected\n');
      const snapshot = await captureSelection(
        f.cli,
        'fixture',
        await readWorkingChanges(f.cli, 'fixture'),
      );

      if (change === 'content')
        await writeFile(join(f.root, 'sample.txt'), 'different\n');
      if (change === 'index') await f.runGit(['add', '.']);
      if (change === 'head')
        await f.runGit(['commit', '--allow-empty', '-m', 'Other']);
      if (change === 'operation')
        await writeFile(join(f.root, '.git', 'MERGE_HEAD'), `${f.a}\n`);
      const before = await f.state();

      await expect(
        (action === 'commit' ? commitSelected : stashSelected)(
          f.cli,
          'fixture',
          snapshot,
          'Refuse',
        ),
      ).rejects.toThrow(/changed|current Git operation|conflict/i);
      expect(await f.state()).toEqual(before);
    });
  }
}

test('a failed commit hook preserves HEAD, files, and the real index', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'selected\n');
  const hook = join(f.root, '.git', 'hooks', 'pre-commit');

  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  const snapshot = await captureSelection(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );
  const before = await f.state();

  await expect(
    commitSelected(f.cli, 'fixture', snapshot, 'Fail'),
  ).rejects.toThrow();
  expect(await f.state()).toEqual(before);
});

test('status preserves unusual paths and combines staged and working changes', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'staged\n');
  await f.runGit(['add', '.']);
  await writeFile(join(f.root, 'sample.txt'), 'working\n');
  const path =
    process.platform === 'win32' ? 'space ü.txt' : 'line\nbreak\t ü.txt';

  await writeFile(join(f.root, path), 'new');
  const files = await readWorkingChanges(f.cli, 'fixture');

  assert.ok(files.find((file) => file.path === path)?.untracked);
  expect(files.find((file) => file.path === 'sample.txt')).toMatchObject({
    staged: true,
    working: true,
    status: 'MM',
  });
});

for (const action of ['commit', 'stash'] as const) {
  test(`${action} supports staged deletions and staged new files`, async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    await f.runGit(['rm', 'sample.txt']);
    await writeFile(join(f.root, 'added'), 'added\n');
    await f.runGit(['add', 'added']);
    await writeFile(join(f.root, 'added'), 'whole working\n');
    const selection = await captureSelection(
      f.cli,
      'fixture',
      await readWorkingChanges(f.cli, 'fixture'),
    );
    const { sha } = await (
      action === 'commit' ? commitSelected : stashSelected
    )(f.cli, 'fixture', selection, 'Staged files');

    expect(await f.runGit(['show', `${sha}:added`])).toBe('whole working\n');
    expect(await f.runGit(['ls-tree', '--name-only', sha])).toBe('added\n');
    expect(await f.runGit(['status', '--porcelain'])).toBe('');
    if (action === 'stash') {
      await f.runGit(['stash', 'apply', sha]);
      expect(await readFile(join(f.root, 'added'), 'utf8')).toBe(
        'whole working\n',
      );
      await expect(readFile(join(f.root, 'sample.txt'))).rejects.toThrow();
    }
  });
}

test('checked files can create the first commit while preserving an unchecked staged file', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await f.runGit(['checkout', '--orphan', 'unborn']);
  await f.runGit(['rm', '-rf', '.']);
  await writeFile(join(f.root, 'checked'), 'checked\n');
  await writeFile(join(f.root, 'unchecked'), 'unchecked\n');
  await f.runGit(['add', 'unchecked']);
  const files = (await readWorkingChanges(f.cli, 'fixture')).filter(
    (file) => file.path === 'checked',
  );
  const snapshot = await captureSelection(f.cli, 'fixture', files);

  expect(snapshot.head).toBeNull();
  const { sha } = await commitSelected(
    f.cli,
    'fixture',
    snapshot,
    'First checked commit',
  );

  expect(await f.runGit(['ls-tree', '--name-only', sha])).toBe('checked\n');
  expect(await f.runGit(['show', '-s', '--format=%P', sha])).toBe('\n');
  expect(await f.runGit(['diff', '--name-only', '--cached'])).toBe(
    'unchecked\n',
  );
});

test('unresolved conflicts refuse capture without mutating the index or worktree', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await f.runGit(['checkout', '-b', 'conflict', f.a]);
  await writeFile(join(f.root, 'sample.txt'), 'Conflict\n');
  await f.runGit(['commit', '-am', 'Conflicting side']);
  await expect(f.runGit(['merge', 'main'])).rejects.toThrow();
  const before = await f.state();

  await expect(
    captureSelection(
      f.cli,
      'fixture',
      await readWorkingChanges(f.cli, 'fixture'),
    ),
  ).rejects.toThrow(/conflict/i);
  expect(await f.state()).toEqual(before);
});

test('a commit created before index reconciliation failure is reported without a second commit', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'unchecked'), 'unchecked\n');
  await writeFile(join(f.root, 'sample.txt'), 'selected\n');
  const hook = join(f.root, '.git', 'hooks', 'post-commit');

  await writeFile(
    hook,
    '#!/bin/sh\nunset GIT_INDEX_FILE\ngit add -- unchecked\n',
  );
  await chmod(hook, 0o755);
  const files = (await readWorkingChanges(f.cli, 'fixture')).filter(
    (file) => file.path === 'sample.txt',
  );
  const snapshot = await captureSelection(f.cli, 'fixture', files);

  await expect(
    commitSelected(f.cli, 'fixture', snapshot, 'Created once'),
  ).rejects.toThrow(/Commit [a-f0-9]+ was created/);
  expect(await f.runGit(['rev-list', '--count', `${f.c}..HEAD`])).toBe('1\n');
  expect(await f.runGit(['show', 'HEAD:sample.txt'])).toBe('selected\n');
  expect(await f.runGit(['ls-tree', '--name-only', 'HEAD'])).toBe(
    'sample.txt\n',
  );
  expect(await f.runGit(['diff', '--name-only', '--cached'])).toContain(
    'unchecked',
  );
});

test('CLI ignores inherited repository and index routing for reads, stdin, and private-index commits', async (t) => {
  const f = await createSquashFixture();
  const other = await createSquashFixture();

  t.onTestFinished(async () => {
    await f.dispose();
    await other.dispose();
  });
  await writeFile(join(f.root, 'sample.txt'), 'target\n');
  const beforeOther = await other.state();
  const inherited = {
    GIT_DIR: join(other.root, '.git'),
    GIT_WORK_TREE: other.root,
    GIT_COMMON_DIR: join(other.root, '.git'),
    GIT_INDEX_FILE: join(other.root, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: join(other.root, '.git', 'objects'),
    GIT_LITERAL_PATHSPECS: '1',
  };
  const saved = Object.fromEntries(
    Object.keys(inherited).map((name) => [name, process.env[name]]),
  );

  try {
    Object.assign(process.env, inherited);
    const files = await readWorkingChanges(f.cli, 'fixture');
    const snapshot = await captureSelection(f.cli, 'fixture', files);

    await commitSelected(f.cli, 'fixture', snapshot, 'Target only');
    expect(
      await f.cli.runWithInput(
        'fixture',
        ['hash-object', '--stdin'],
        'target\n',
      ),
    ).toBe(await f.runGit(['rev-parse', 'HEAD:sample.txt']));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  expect(await other.state()).toEqual(beforeOther);
  expect(await f.runGit(['show', 'HEAD:sample.txt'])).toBe('target\n');
});

test('an untracked-only stash restores through ordinary Git stash apply', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'new'), 'untracked\n');
  const snapshot = await captureSelection(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );
  const { sha } = await stashSelected(f.cli, 'fixture', snapshot, 'Untracked');

  expect(await f.runGit(['status', '--porcelain'])).toBe('');
  await f.runGit(['stash', 'apply', sha]);
  expect(await readFile(join(f.root, 'new'), 'utf8')).toBe('untracked\n');
});

test('a selected staged edit reverted in the working file cannot create an empty commit', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'staged\n');
  await f.runGit(['add', '.']);
  await writeFile(
    join(f.root, 'sample.txt'),
    await f.runGit(['show', 'HEAD:sample.txt']),
  );
  const snapshot = await captureSelection(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );
  const before = await f.state();

  await expect(
    commitSelected(f.cli, 'fixture', snapshot, 'Empty'),
  ).rejects.toThrow(/no changes/i);
  expect(await f.state()).toEqual(before);
  const { sha } = await stashSelected(f.cli, 'fixture', snapshot, 'Index only');

  expect(await f.runGit(['show', `${sha}^2:sample.txt`])).toBe('staged\n');
  expect(await f.runGit(['diff', '--name-only', `${sha}^`, sha])).toBe('');
  expect(await f.runGit(['status', '--porcelain'])).toBe('');
});

test('switching to a different branch at the same HEAD invalidates a checked selection', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'selected\n');
  const snapshot = await captureSelection(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );

  await f.runGit(['checkout', '-b', 'other-branch']);
  const before = await f.state();

  await expect(
    commitSelected(f.cli, 'fixture', snapshot, 'Refuse branch change'),
  ).rejects.toThrow(/changed/i);
  expect(await f.state()).toEqual(before);
});

test('byte output and stdin preserve non-UTF8 text patch contents', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  const bytes = Buffer.from([0x74, 0x65, 0x78, 0x74, 0xfe, 0x0a]);

  await writeFile(join(f.root, 'sample.txt'), bytes);
  const patch = await f.cli.runBytes('fixture', [
    'diff',
    '--binary',
    'HEAD',
    '--',
    'sample.txt',
  ]);

  expect(patch.includes(0xfe)).toBe(true);
  await f.runGit(['restore', 'sample.txt']);
  await f.cli.runWithInput('fixture', ['apply', '--binary', '-'], patch);
  expect(await readFile(join(f.root, 'sample.txt'))).toEqual(bytes);
});

test('a harmless Git index stat refresh does not invalidate checked file contents', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'stable'), 'stable\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Stable file']);
  await writeFile(join(f.root, 'sample.txt'), 'selected\n');
  const snapshot = await captureSelection(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );
  const later = new Date(Date.now() + 2000);

  await utimes(join(f.root, 'stable'), later, later);
  await f.runGit(['update-index', '--refresh']).catch(() => '');
  await commitSelected(f.cli, 'fixture', snapshot, 'Selected after refresh');
  expect(await f.runGit(['show', 'HEAD:sample.txt'])).toBe('selected\n');
});

test('a stash saved before an external edit reports incomplete cleanup and preserves the new contents', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'selected\n');
  const snapshot = await captureSelection(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );
  const hook = join(f.root, '.git', 'hooks', 'reference-transaction');

  await writeFile(
    hook,
    '#!/bin/sh\nif [ "$1" = committed ]; then\n  while read old new ref; do\n    if [ "$ref" = refs/stash ]; then printf "external edit\\n" > sample.txt; fi\n  done\nfi\n',
  );
  await chmod(hook, 0o755);
  await expect(
    stashSelected(f.cli, 'fixture', snapshot, 'Saved once'),
  ).rejects.toThrow(/Stash [a-f0-9]+ was saved/);
  expect(await f.runGit(['stash', 'list', '--format=%s'])).toBe('Saved once\n');
  expect(await f.runGit(['show', 'stash:sample.txt'])).toBe('selected\n');
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe(
    'external edit\n',
  );
  expect(await f.runGit(['diff', '--cached', '--name-only'])).toBe('');
});
