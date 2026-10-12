import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, onTestFinished, test } from 'vitest';

import {
  captureSelection,
  commitSelected,
  stashSelected,
} from '../../src/extension/git/source-control/selected-changes';
import { readWorkingChanges } from '../../src/extension/git/source-control/working-changes';
import { createSquashFixture } from '../fixtures/squash-repository';

test.each([false, true])(
  'amending with selected changes=%s preserves parents, author and unchecked staging',
  async (changes) => {
    const f = await createSquashFixture();

    onTestFinished(() => f.dispose());
    const head = (await f.runGit(['rev-parse', 'HEAD'])).trim();
    const metadata = await f.runGit([
      'show',
      '-s',
      '--format=%P%n%an%n%ae%n%aI',
      head,
    ]);

    await writeFile(join(f.root, 'unchecked.txt'), 'staged\n');
    await f.runGit(['add', 'unchecked.txt']);
    await writeFile(join(f.root, 'unchecked.txt'), 'working\n');
    if (changes) await writeFile(join(f.root, 'sample.txt'), 'amended\n');
    const index = await f.runGit([
      'ls-files',
      '--stage',
      '--',
      'unchecked.txt',
    ]);
    const files = (await readWorkingChanges(f.cli, 'fixture')).filter(
      (file) => changes && file.path === 'sample.txt',
    );
    const mode = { kind: 'amend', headSha: head } as const;
    const snapshot = await captureSelection(f.cli, 'fixture', files, mode);
    const result = await commitSelected(
      f.cli,
      'fixture',
      snapshot,
      'Amended subject\n\nFull body',
      mode,
    );

    expect(result.sha).not.toBe(head);
    expect(
      await f.runGit(['show', '-s', '--format=%P%n%an%n%ae%n%aI', result.sha]),
    ).toBe(metadata);
    expect(await f.runGit(['show', '-s', '--format=%B', result.sha])).toBe(
      'Amended subject\n\nFull body\n\n',
    );
    expect(await f.runGit(['ls-files', '--stage', '--', 'unchecked.txt'])).toBe(
      index,
    );
    expect(await readFile(join(f.root, 'unchecked.txt'), 'utf8')).toBe(
      'working\n',
    );
    expect(await f.runGit(['show', 'HEAD:sample.txt'])).toBe(
      changes ? 'amended\n' : 'C\n',
    );
    expect((await f.runGit(['rev-list', '--count', 'HEAD'])).trim()).toBe('4');
    if (changes)
      expect(
        (await f.runGit(['diff', 'HEAD', '--', 'sample.txt'])).trim(),
      ).toBe('');
  },
);

test('Amend refuses a last commit that changed after the toolbar selection', async () => {
  const f = await createSquashFixture();

  onTestFinished(() => f.dispose());
  const head = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await writeFile(join(f.root, 'sample.txt'), 'later\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Later commit']);
  const current = await f.runGit(['rev-parse', 'HEAD']);

  await expect(
    captureSelection(f.cli, 'fixture', [], { kind: 'amend', headSha: head }),
  ).rejects.toThrow('last commit changed');
  expect(await f.runGit(['rev-parse', 'HEAD'])).toBe(current);
});

test('a message-only Amend snapshot cannot create a new commit or empty stash', async () => {
  const f = await createSquashFixture();

  onTestFinished(() => f.dispose());
  const snapshot = await captureSelection(f.cli, 'fixture', [], {
    kind: 'amend',
    headSha: f.c,
  });
  const before = await f.state();

  await expect(
    commitSelected(f.cli, 'fixture', snapshot, 'No selection'),
  ).rejects.toThrow();
  await expect(
    stashSelected(f.cli, 'fixture', snapshot, 'No selection'),
  ).rejects.toThrow();
  expect(await f.state()).toEqual(before);
});

test.each(['root', 'merge'] as const)(
  'message-only Amend preserves a %s commit tree and parents',
  async (kind) => {
    const f = await createSquashFixture();

    onTestFinished(() => f.dispose());
    if (kind === 'root') await f.runGit(['reset', '--hard', f.initial]);
    else {
      await f.runGit(['checkout', '-b', 'side', f.a]);
      await writeFile(join(f.root, 'side.txt'), 'side\n');
      await f.runGit(['add', 'side.txt']);
      await f.runGit(['commit', '-m', 'Side']);
      await f.runGit(['checkout', 'main']);
      await f.runGit(['merge', '--no-ff', 'side', '-m', 'Merge']);
    }

    const headSha = (await f.runGit(['rev-parse', 'HEAD'])).trim();
    const mode = { kind: 'amend', headSha } as const;
    const metadata = await f.runGit([
      'show',
      '-s',
      '--format=%T%n%P%n%an%n%ae%n%aI',
      'HEAD',
    ]);
    const snapshot = await captureSelection(f.cli, 'fixture', [], mode);

    await commitSelected(f.cli, 'fixture', snapshot, 'Reword only', mode);
    expect(
      await f.runGit(['show', '-s', '--format=%T%n%P%n%an%n%ae%n%aI', 'HEAD']),
    ).toBe(metadata);
    expect(await f.runGit(['status', '--porcelain'])).toBe('');
  },
);

test.each([false, true])(
  'Amend with selected changes=%s refuses hooks that stage unchecked files',
  async (changes) => {
    const f = await createSquashFixture();

    onTestFinished(() => f.dispose());
    await writeFile(join(f.root, 'unchecked.txt'), 'unchecked\n');
    if (changes) await writeFile(join(f.root, 'sample.txt'), 'selected\n');
    const hook = join(f.root, '.git', 'hooks', 'pre-commit');

    await writeFile(hook, '#!/bin/sh\ngit add -- unchecked.txt\n');
    await chmod(hook, 0o755);
    const mode = { kind: 'amend', headSha: f.c } as const;
    const files = (await readWorkingChanges(f.cli, 'fixture')).filter(
      (file) => changes && file.path === 'sample.txt',
    );
    const snapshot = await captureSelection(f.cli, 'fixture', files, mode);
    const before = await f.state();

    await expect(
      commitSelected(f.cli, 'fixture', snapshot, 'Refuse hook scope', mode),
    ).rejects.toThrow(/hook|unchecked/i);
    expect(await f.state()).toEqual(before);
  },
);
