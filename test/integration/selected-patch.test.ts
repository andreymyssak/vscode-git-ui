import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { GitCli, type PrivateIndex } from '../../src/extension/git/cli';
import {
  readSelectedPatch,
  validateSelectedPatch,
} from '../../src/extension/git/selected-patch';
import { readWorkingChanges } from '../../src/extension/git/working-changes';
import { createSquashFixture } from '../fixtures/squash-repository';

test('selected patch describes whole working files, including literal new/deleted/renamed paths, while preserving Git state', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  for (const path of ['unchecked', 'deleted', 'old', '[literal].bin'])
    await writeFile(
      join(f.root, path),
      path === 'old' ? 'rename original\n' : 'base\n',
    );
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Base files']);
  await writeFile(join(f.root, 'unchecked'), 'unchecked staged secret\n');
  await writeFile(join(f.root, 'sample.txt'), 'checked staging only\n');
  await f.runGit(['add', '.']);
  await writeFile(join(f.root, 'unchecked'), 'unchecked working secret\n');
  await writeFile(
    join(f.root, 'unchecked-new'),
    'unchecked untracked secret\n',
  );
  await writeFile(join(f.root, 'sample.txt'), 'checked whole working file\n');
  const added =
    process.platform === 'win32' ? '[new] ü.txt' : ':new [x]\nü.txt';
  const renamed =
    process.platform === 'win32' ? '[renamed].txt' : ':renamed [x].txt';

  await writeFile(join(f.root, added), 'new selected content\n');
  await writeFile(join(f.root, '[literal].bin'), Buffer.from([0, 255, 1, 2]));
  await rm(join(f.root, 'deleted'));
  await rename(join(f.root, 'old'), join(f.root, renamed));
  await f.runGit(['add', '--', ':(literal)old', `:(literal)${renamed}`]);
  const files = (await readWorkingChanges(f.cli, 'fixture')).filter(
    (file) => !file.path.startsWith('unchecked'),
  );
  const before = await f.state();
  const patch = await readSelectedPatch(f.cli, 'fixture', files);

  expect(patch.text).toContain('+checked whole working file');
  expect(patch.text).toContain('+new selected content');
  expect(patch.text).toContain('deleted file mode');
  expect(patch.text).toContain('rename from old');
  expect(patch.text).toContain('Binary files');
  expect(patch.text).not.toMatch(
    /unchecked|checked staging only|GIT binary patch|\0/,
  );
  expect(patch.files.map((file) => file.path)).toEqual(
    files.map((file) => file.path),
  );
  await validateSelectedPatch(f.cli, 'fixture', patch);
  expect(await f.state()).toEqual(before);
});

test('unborn repository patch compares checked files with an empty base and preserves unchecked staging', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await f.runGit(['checkout', '--orphan', 'unborn']);
  await f.runGit(['rm', '-rf', '.']);
  await writeFile(join(f.root, 'checked'), 'first selected file\n');
  await writeFile(join(f.root, 'unchecked'), 'unchecked staged secret\n');
  await f.runGit(['add', 'unchecked']);
  const files = (await readWorkingChanges(f.cli, 'fixture')).filter(
    (file) => file.path === 'checked',
  );
  const index = await readFile(join(f.root, '.git', 'index'));
  const refs = await f.runGit(['show-ref']);
  const patch = await readSelectedPatch(f.cli, 'fixture', files);

  expect(patch.snapshot.head).toBeNull();
  expect(patch.text).toContain('new file mode');
  expect(patch.text).toContain('+first selected file');
  expect(patch.text).not.toContain('unchecked');
  expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index);
  expect(await f.runGit(['show-ref'])).toBe(refs);
  expect(await f.runGit(['symbolic-ref', 'HEAD'])).toBe('refs/heads/unborn\n');
  expect(await readFile(join(f.root, 'checked'), 'utf8')).toBe(
    'first selected file\n',
  );
  expect(await readFile(join(f.root, 'unchecked'), 'utf8')).toBe(
    'unchecked staged secret\n',
  );
});

for (const change of ['content', 'index', 'head', 'branch'] as const) {
  test(`patch capture refuses ${change} changing during preparation without additional writes`, async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    await writeFile(join(f.root, 'sample.txt'), 'selected\n');
    const files = await readWorkingChanges(f.cli, 'fixture');
    let changedState: Awaited<ReturnType<typeof f.state>> | undefined;

    class ChangingCli extends GitCli {
      override withTemporaryIndex<T>(
        id: string,
        callback: (index: PrivateIndex) => Promise<T>,
      ): Promise<T> {
        return super.withTemporaryIndex(id, async (index) => {
          const result = await callback(index);

          if (change === 'content')
            await writeFile(join(f.root, 'sample.txt'), 'changed\n');
          if (change === 'index') await f.runGit(['add', '.']);
          if (change === 'head')
            await f.runGit(['commit', '--allow-empty', '-m', 'Other']);
          if (change === 'branch') await f.runGit(['checkout', '-b', 'other']);
          changedState = await f.state();

          return result;
        });
      }
    }

    await expect(
      readSelectedPatch(new ChangingCli(f.access), 'fixture', files),
    ).rejects.toThrow(/changed/i);
    expect(await f.state()).toEqual(changedState);
  });

  test(`prepared patch rejects stale ${change} before a generated draft can be used`, async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    await writeFile(join(f.root, 'sample.txt'), 'selected\n');
    const patch = await readSelectedPatch(
      f.cli,
      'fixture',
      await readWorkingChanges(f.cli, 'fixture'),
    );

    if (change === 'content')
      await writeFile(join(f.root, 'sample.txt'), 'changed\n');
    if (change === 'index') await f.runGit(['add', '.']);
    if (change === 'head')
      await f.runGit(['commit', '--allow-empty', '-m', 'Other']);
    if (change === 'branch') await f.runGit(['checkout', '-b', 'other']);
    const before = await f.state();

    await expect(
      validateSelectedPatch(f.cli, 'fixture', patch),
    ).rejects.toThrow(/changed/i);
    expect(await f.state()).toEqual(before);
  });
}

test('index-only edits reverted in working files have no changes to describe', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'staged\n');
  await f.runGit(['add', '.']);
  await writeFile(
    join(f.root, 'sample.txt'),
    await f.runGit(['show', 'HEAD:sample.txt']),
  );
  const before = await f.state();

  await expect(
    readSelectedPatch(
      f.cli,
      'fixture',
      await readWorkingChanges(f.cli, 'fixture'),
    ),
  ).rejects.toThrow(/no changes/i);
  expect(await f.state()).toEqual(before);
});

test('a staged new file absent from the working tree does not leak staged content into a selected patch', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'absent'), 'staging secret\n');
  await f.runGit(['add', 'absent']);
  await rm(join(f.root, 'absent'));
  await writeFile(join(f.root, 'sample.txt'), 'selected\n');
  const before = await f.state();
  const patch = await readSelectedPatch(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );

  expect(patch.text).toContain('+selected');
  expect(patch.text).not.toContain('staging secret');
  expect(await f.state()).toEqual(before);
});

test('binary payload stays omitted when repository attributes force a text diff', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, '.gitattributes'), '*.bin diff\n');
  await f.runGit(['add', '.gitattributes']);
  await f.runGit(['commit', '-m', 'Force text diff']);
  await writeFile(
    join(f.root, 'forced.bin'),
    Buffer.from('private binary\0payload\n'),
  );
  const before = await f.state();
  const patch = await readSelectedPatch(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );

  expect(patch.text).toContain('forced.bin');
  expect(patch.text).toMatch(/binary.*omitted/i);
  expect(patch.text).not.toMatch(/private binary|payload|\0/);
  expect(await f.state()).toEqual(before);
});

test('non-UTF-8 patch bodies are omitted while valid replacement characters remain intact', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(
    join(f.root, 'sample.txt'),
    Buffer.from([0x74, 0x65, 0x78, 0x74, 0xfe, 0x0a]),
  );
  await writeFile(
    join(f.root, 'unicode.txt'),
    'A valid replacement character: �\n',
  );
  const before = await f.state();
  const patch = await readSelectedPatch(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );

  expect(patch.text).toContain('sample.txt');
  expect(patch.text).toContain('non-UTF-8 content omitted');
  expect(patch.text).not.toContain('+text�');
  expect(patch.text).toContain('+A valid replacement character: �');
  expect(await f.state()).toEqual(before);
});

test('large selected patches fail explicitly without a partial result or Git mutations', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'large line\n'.repeat(40000));
  const before = await f.state();

  await expect(
    readSelectedPatch(
      f.cli,
      'fixture',
      await readWorkingChanges(f.cli, 'fixture'),
    ),
  ).rejects.toThrow(/too large.*fewer/i);
  expect(await f.state()).toEqual(before);
});

test('cancelled patch preparation leaves the index, working files and refs unchanged', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'selected\n');
  const files = await readWorkingChanges(f.cli, 'fixture');
  const before = await f.state();
  const abort = new AbortController();

  abort.abort();
  await expect(
    readSelectedPatch(f.cli, 'fixture', files, abort.signal),
  ).rejects.toThrow();
  expect(await f.state()).toEqual(before);
});

test('cancellation after private staging leaves the real index, working files and refs unchanged', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'selected\n');
  const files = await readWorkingChanges(f.cli, 'fixture');
  const before = await f.state();
  const abort = new AbortController();

  class CancellingCli extends GitCli {
    override withTemporaryIndex<T>(
      id: string,
      callback: (index: PrivateIndex) => Promise<T>,
    ): Promise<T> {
      return super.withTemporaryIndex(id, (index) =>
        callback({
          run: async (args, input) => {
            const result = await index.run(args, input);

            if (args[0] === 'add') abort.abort();

            return result;
          },
        }),
      );
    }
  }

  await expect(
    readSelectedPatch(
      new CancellingCli(f.access),
      'fixture',
      files,
      abort.signal,
    ),
  ).rejects.toThrow();
  expect(await f.state()).toEqual(before);
});
