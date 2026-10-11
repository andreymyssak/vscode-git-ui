import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, onTestFinished, test } from 'vitest';

import {
  captureRollback,
  rollbackSelected,
} from '../../src/extension/git/rollback';
import { readWorkingChanges } from '../../src/extension/git/working-changes';
import { createSquashFixture } from '../fixtures/squash-repository';

test('Rollback restores selected staged and working versions to HEAD and preserves other staging and new files', async () => {
  const f = await createSquashFixture();

  onTestFinished(() => f.dispose());
  await writeFile(join(f.root, '[a].txt'), 'base\n');
  await writeFile(join(f.root, 'a.txt'), 'base\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Base']);
  const head = await f.runGit(['rev-parse', 'HEAD']);

  await writeFile(join(f.root, 'sample.txt'), 'other staged\n');
  await writeFile(join(f.root, '[a].txt'), 'selected staged\n');
  await writeFile(join(f.root, 'new.txt'), 'new\n');
  await f.runGit(['add', '.']);
  await writeFile(join(f.root, '[a].txt'), 'selected working\n');
  await writeFile(join(f.root, 'a.txt'), 'keep literal neighbor\n');
  const files = (await readWorkingChanges(f.cli, 'fixture')).filter((file) =>
    ['[a].txt', 'new.txt'].includes(file.path),
  );
  const plan = await captureRollback(f.cli, 'fixture', files);

  await rollbackSelected(f.cli, 'fixture', plan);
  expect(await f.runGit(['rev-parse', 'HEAD'])).toBe(head);
  expect(await readFile(join(f.root, '[a].txt'), 'utf8')).toBe('base\n');
  expect(await f.runGit(['show', ':[a].txt'])).toBe('base\n');
  expect(await readFile(join(f.root, 'a.txt'), 'utf8')).toBe(
    'keep literal neighbor\n',
  );
  expect(await f.runGit(['show', ':sample.txt'])).toBe('other staged\n');
  expect(await readFile(join(f.root, 'new.txt'), 'utf8')).toBe('new\n');
  expect(await f.runGit(['ls-files', '--', 'new.txt'])).toBe('');
});

test('Rollback of a selected rename restores the original name and keeps the new copy for the explicit deletion choice', async () => {
  const f = await createSquashFixture();

  onTestFinished(() => f.dispose());
  await rename(join(f.root, 'sample.txt'), join(f.root, 'renamed.txt'));
  await f.runGit(['add', '.']);
  const files = await readWorkingChanges(f.cli, 'fixture');
  const plan = await captureRollback(f.cli, 'fixture', files);

  await rollbackSelected(f.cli, 'fixture', plan);
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe('C\n');
  expect(await f.runGit(['ls-files', '--', 'renamed.txt'])).toBe('');
  expect(await readFile(join(f.root, 'renamed.txt'), 'utf8')).toBe('C\n');
  expect(plan.newFiles.map((file) => file.path)).toEqual(['renamed.txt']);
});

test('Rollback rejects edits made after the reviewed snapshot before modifying staging or files', async () => {
  const f = await createSquashFixture();

  onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'staged\n');
  await f.runGit(['add', '.']);
  const plan = await captureRollback(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );

  await writeFile(join(f.root, 'sample.txt'), 'later work\n');
  await expect(rollbackSelected(f.cli, 'fixture', plan)).rejects.toThrow(
    /changed/,
  );
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe(
    'later work\n',
  );
  expect(await f.runGit(['show', ':sample.txt'])).toBe('staged\n');
});

test('Rollback checks that its host target is still live immediately before a write', async () => {
  const f = await createSquashFixture();

  onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'keep this edit\n');
  const plan = await captureRollback(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );

  await expect(
    rollbackSelected(f.cli, 'fixture', plan, () => {
      throw new Error('The repository closed.');
    }),
  ).rejects.toThrow();
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe(
    'keep this edit\n',
  );
});
