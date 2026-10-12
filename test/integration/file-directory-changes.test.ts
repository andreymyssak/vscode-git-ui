import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, onTestFinished, test } from 'vitest';

import {
  captureRollback,
  rollbackSelected,
} from '../../src/extension/git/source-control/rollback';
import {
  captureSelection,
  commitSelected,
  stashSelected,
} from '../../src/extension/git/source-control/selected-changes';
import { readSelectedPatch } from '../../src/extension/git/source-control/selected-patch';
import { readWorkingChanges } from '../../src/extension/git/source-control/working-changes';
import { createSquashFixture } from '../fixtures/squash-repository';

async function replacement(direction: 'file' | 'directory', staged: boolean) {
  const f = await createSquashFixture();

  onTestFinished(() => f.dispose());
  if (direction === 'file') {
    await mkdir(join(f.root, 'folder'));
    await writeFile(join(f.root, 'folder/child.txt'), 'base\n');
    await f.runGit(['add', '.']);
    await f.runGit(['commit', '-m', 'Base directory']);
  }

  const old = direction === 'directory' ? 'sample.txt' : 'folder/child.txt';
  const added =
    direction === 'directory' ? 'sample.txt/nested/new.txt' : 'folder';

  await rm(join(f.root, direction === 'directory' ? 'sample.txt' : 'folder'), {
    recursive: true,
  });
  if (direction === 'directory')
    await mkdir(join(f.root, 'sample.txt/nested'), { recursive: true });
  await writeFile(join(f.root, added), 'replacement\n');
  if (staged) await f.runGit(['add', '--all']);
  await writeFile(join(f.root, 'other.txt'), 'unrelated staged\n');
  await f.runGit(['add', 'other.txt']);
  await writeFile(join(f.root, 'other.txt'), 'unrelated working\n');
  const files = (await readWorkingChanges(f.cli, 'fixture')).filter(
    (file) => file.path !== 'other.txt',
  );

  return { f, files, old, added };
}

for (const direction of ['file', 'directory'] as const) {
  for (const staged of [false, true]) {
    for (const action of ['commit', 'stash'] as const) {
      test(`${action} a ${staged ? 'staged' : 'unstaged'} replacement by a ${direction} preserves unrelated staging`, async () => {
        const { f, files, old, added } = await replacement(direction, staged);
        const before = await f.state();
        const patch = await readSelectedPatch(f.cli, 'fixture', files);

        expect(patch.text).toContain('replacement');
        expect(patch.text).not.toContain('other.txt');
        expect(await f.state()).toEqual(before);
        const snapshot = await captureSelection(f.cli, 'fixture', files);
        const { sha } = await (
          action === 'commit' ? commitSelected : stashSelected
        )(f.cli, 'fixture', snapshot, 'Replace file and directory');

        expect(await f.runGit(['show', ':other.txt'])).toBe(
          'unrelated staged\n',
        );
        expect(await readFile(join(f.root, 'other.txt'), 'utf8')).toBe(
          'unrelated working\n',
        );
        if (action === 'commit') {
          expect(await f.runGit(['show', `HEAD:${added}`])).toBe(
            'replacement\n',
          );
          expect(
            await f.runGit(['ls-tree', '-r', '--name-only', 'HEAD']),
          ).not.toContain(`${old}\n`);
        } else {
          expect(
            (await readWorkingChanges(f.cli, 'fixture')).map(
              (file) => file.path,
            ),
          ).toEqual(['other.txt']);
          await f.runGit(['stash', 'apply', sha]);
          expect(await readFile(join(f.root, added), 'utf8')).toBe(
            'replacement\n',
          );
        }
      });
    }
  }

  test(`an incomplete replacement by a ${direction} refuses capture without changing files or staging`, async () => {
    const { f, files, added } = await replacement(direction, false);
    const before = await f.state();

    await expect(
      captureSelection(
        f.cli,
        'fixture',
        files.filter((file) => file.path === added),
      ),
    ).rejects.toThrow(/overlap|replacement/i);
    expect(await f.state()).toEqual(before);
  });
  test(`Rollback keeps new files that block a replacement by a ${direction}`, async () => {
    const { f, files, added } = await replacement(direction, false);
    const plan = await captureRollback(f.cli, 'fixture', files);
    const before = await f.state();

    await expect(rollbackSelected(f.cli, 'fixture', plan)).rejects.toThrow(
      /move or delete/i,
    );
    expect(await f.state()).toEqual(before);
    expect(await readFile(join(f.root, added), 'utf8')).toBe('replacement\n');
  });
}

test('a new unchecked descendant invalidates a reviewed replacement before commit', async () => {
  const { f, files } = await replacement('directory', false);
  const snapshot = await captureSelection(f.cli, 'fixture', files);

  await writeFile(join(f.root, 'sample.txt/later.txt'), 'keep this\n');
  const before = await f.state();

  await expect(
    commitSelected(f.cli, 'fixture', snapshot, 'Refuse changed selection'),
  ).rejects.toThrow(/changed/i);
  expect(await f.state()).toEqual(before);
});

test('a commit hook cannot stage unchecked descendants beneath a selected replacement', async () => {
  const { f, files } = await replacement('directory', false);
  const snapshot = await captureSelection(f.cli, 'fixture', files);
  const hook = join(f.root, '.git', 'hooks', 'pre-commit');

  await writeFile(
    hook,
    '#!/bin/sh\nprintf "unchecked\\n" > sample.txt/extra.txt\ngit add -- sample.txt/extra.txt\n',
  );
  await chmod(hook, 0o755);
  const head = await f.runGit(['rev-parse', 'HEAD']);
  const index = await f.runGit(['ls-files', '--stage']);

  await expect(
    commitSelected(f.cli, 'fixture', snapshot, 'Refuse hook extra'),
  ).rejects.toThrow();
  expect(await f.runGit(['rev-parse', 'HEAD'])).toBe(head);
  expect(await f.runGit(['ls-files', '--stage'])).toBe(index);
  expect(await readFile(join(f.root, 'sample.txt/extra.txt'), 'utf8')).toBe(
    'unchecked\n',
  );
});
