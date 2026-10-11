import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assert, expect, test } from 'vitest';

import {
  captureSelection,
  commitSelected,
  stashSelected,
} from '../../src/extension/git/selected-changes';
import { readWorkingChanges } from '../../src/extension/git/working-changes';
import { createSquashFixture } from '../fixtures/squash-repository';

for (const hookName of ['pre-commit', 'prepare-commit-msg', 'commit-msg']) {
  test(`${hookName} cannot add unchecked files to a checked-file commit`, async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    await writeFile(join(f.root, 'unchecked'), 'base\n');
    await f.runGit(['add', '.']);
    await f.runGit(['commit', '-m', 'Unchecked base']);
    await writeFile(join(f.root, 'unchecked'), 'staged\n');
    await f.runGit(['add', 'unchecked']);
    await writeFile(join(f.root, 'unchecked'), 'working\n');
    await writeFile(join(f.root, 'sample.txt'), 'selected\n');
    const hooks = join(f.directory, 'custom hooks');

    await mkdir(hooks);
    await f.runGit(['config', 'core.hooksPath', hooks]);
    const hook = join(hooks, hookName);

    await writeFile(hook, '#!/bin/sh\ngit add -- unchecked\n');
    await chmod(hook, 0o755);
    const files = (await readWorkingChanges(f.cli, 'fixture')).filter(
      (file) => file.path === 'sample.txt',
    );
    const snapshot = await captureSelection(f.cli, 'fixture', files);
    const before = await f.state();

    await expect(
      commitSelected(f.cli, 'fixture', snapshot, 'Refuse hook scope'),
    ).rejects.toThrow(/hook|unchecked/i);
    expect(await f.state()).toEqual(before);
  });
}

test('configured hooks can format checked files and edit commit messages without bypassing post-commit', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'selected\n');
  const hooks = join(f.directory, "configured hooks ' ü");

  await mkdir(hooks);
  await f.runGit(['config', 'core.hooksPath', hooks]);
  for (const [name, body] of [
    ['pre-commit', 'printf "formatted\\n" > sample.txt\ngit add -- sample.txt'],
    ['prepare-commit-msg', 'printf "\\nPrepared\\n" >> "$1"'],
    ['commit-msg', 'printf "\\nValidated\\n" >> "$1"'],
    ['post-commit', 'printf "ran\\n" > .git/hook-ran'],
  ]) {
    assert.ok(name && body);
    const hook = join(hooks, name);

    await writeFile(hook, `#!/bin/sh\n${body}\n`);
    await chmod(hook, 0o755);
  }

  const snapshot = await captureSelection(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );
  const { sha } = await commitSelected(
    f.cli,
    'fixture',
    snapshot,
    'Original message',
  );

  expect(await f.runGit(['show', `${sha}:sample.txt`])).toBe('formatted\n');
  expect(await f.runGit(['show', '-s', '--format=%B', sha])).toContain(
    'Prepared\n\nValidated',
  );
  expect(await readFile(join(f.root, '.git', 'hook-ran'), 'utf8')).toBe(
    'ran\n',
  );
  expect(await f.runGit(['status', '--porcelain'])).toBe('');
});

for (const action of ['commit', 'stash'] as const) {
  test(`${action} refuses a checked rename overlapping an unchecked replacement file`, async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    await f.runGit(['mv', 'sample.txt', 'renamed.txt']);
    await writeFile(join(f.root, 'sample.txt'), 'unchecked replacement\n');
    const files = (await readWorkingChanges(f.cli, 'fixture')).filter(
      (file) => file.path === 'renamed.txt',
    );
    const before = await f.state();

    await expect(
      (async () => {
        const snapshot = await captureSelection(f.cli, 'fixture', files);

        await (action === 'commit' ? commitSelected : stashSelected)(
          f.cli,
          'fixture',
          snapshot,
          'Overlapping rename',
        );
      })(),
    ).rejects.toThrow(/unchecked|overlap/i);
    expect(await f.state()).toEqual(before);
  });
}

test('a post-commit HEAD move reports the exact created commit without reconciling the real index', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'staged selected\n');
  await f.runGit(['add', '.']);
  await writeFile(join(f.root, 'sample.txt'), 'working selected\n');
  const previousIndex = await f.runGit(['ls-files', '--stage', '-z']);
  const hook = join(f.root, '.git', 'hooks', 'post-commit');

  await writeFile(
    hook,
    `#!/bin/sh\ngit rev-parse HEAD > .git/created-sha\ngit update-ref HEAD ${f.a}\n`,
  );
  await chmod(hook, 0o755);
  const snapshot = await captureSelection(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );
  let reported = '';

  try {
    await commitSelected(f.cli, 'fixture', snapshot, 'Created before move');
  } catch (error) {
    assert.ok(error instanceof Error);
    reported = error.message;
  }

  const created = (
    await readFile(join(f.root, '.git', 'created-sha'), 'utf8')
  ).trim();

  expect(reported).toContain(`Commit ${created} was created`);
  expect(await f.runGit(['rev-parse', 'HEAD'])).toBe(`${f.a}\n`);
  expect(await f.runGit(['ls-files', '--stage', '-z'])).toBe(previousIndex);
  expect(await f.runGit(['show', `${created}:sample.txt`])).toBe(
    'working selected\n',
  );
});

test('a pre-commit branch switch cancels before creating a commit', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await f.runGit(['branch', 'other']);
  await writeFile(join(f.root, 'sample.txt'), 'selected\n');
  const hook = join(f.root, '.git', 'hooks', 'pre-commit');

  await writeFile(hook, '#!/bin/sh\ngit symbolic-ref HEAD refs/heads/other\n');
  await chmod(hook, 0o755);
  const snapshot = await captureSelection(
    f.cli,
    'fixture',
    await readWorkingChanges(f.cli, 'fixture'),
  );
  const before = await f.state();

  await expect(
    commitSelected(f.cli, 'fixture', snapshot, 'No commit on switched branch'),
  ).rejects.toThrow(/branch changed/i);
  expect(await f.state()).toEqual(before);
  expect(await f.runGit(['symbolic-ref', '--short', 'HEAD'])).toBe('other\n');
});

for (const action of ['commit', 'stash'] as const) {
  test(`${action} accepts a rename and overlapping replacement when both are checked`, async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    await f.runGit(['mv', 'sample.txt', 'renamed.txt']);
    await writeFile(join(f.root, 'sample.txt'), 'checked replacement\n');
    const snapshot = await captureSelection(
      f.cli,
      'fixture',
      await readWorkingChanges(f.cli, 'fixture'),
    );
    const { sha } = await (
      action === 'commit' ? commitSelected : stashSelected
    )(f.cli, 'fixture', snapshot, 'Both checked');

    expect(await f.runGit(['show', `${sha}:sample.txt`])).toBe(
      'checked replacement\n',
    );
    expect(await f.runGit(['show', `${sha}:renamed.txt`])).toBe('C\n');
    expect(await f.runGit(['status', '--porcelain'])).toBe('');
  });
}

test.skipIf(process.platform === 'win32')(
  'symlinked configured hooks retain their invocation directory for local configuration',
  async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    const hooks = join(f.directory, 'configured-hooks');
    const shared = join(f.directory, 'shared-script');

    await mkdir(hooks);
    await writeFile(
      shared,
      '#!/bin/sh\n. "$(dirname "$0")/local-config"\nprintf "%s\\n" "$HOOK_VALUE" > .git/hook-value\n',
    );
    await chmod(shared, 0o755);
    await writeFile(
      join(hooks, 'local-config'),
      'HOOK_VALUE=local-configuration\n',
    );
    await symlink(shared, join(hooks, 'pre-commit'));
    await f.runGit(['config', 'core.hooksPath', hooks]);
    await f.runGit(['commit', '--allow-empty', '-m', 'Ordinary Git hook']);
    expect(await readFile(join(f.root, '.git', 'hook-value'), 'utf8')).toBe(
      'local-configuration\n',
    );
    await writeFile(join(f.root, 'sample.txt'), 'selected\n');
    const snapshot = await captureSelection(
      f.cli,
      'fixture',
      await readWorkingChanges(f.cli, 'fixture'),
    );

    await commitSelected(
      f.cli,
      'fixture',
      snapshot,
      'Checked with symlink hook',
    );
    expect(await f.runGit(['show', 'HEAD:sample.txt'])).toBe('selected\n');
    expect(await readFile(join(f.root, '.git', 'hook-value'), 'utf8')).toBe(
      'local-configuration\n',
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'dangling unrelated entries in the configured hook directory do not block commits',
  async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    const hooks = join(f.directory, 'configured-hooks');

    await mkdir(hooks);
    await symlink(
      join(f.directory, 'missing-target'),
      join(hooks, 'unrelated-entry'),
    );
    await f.runGit(['config', 'core.hooksPath', hooks]);
    await f.runGit([
      'commit',
      '--allow-empty',
      '-m',
      'Ordinary Git ignores entry',
    ]);
    await writeFile(join(f.root, 'sample.txt'), 'selected\n');
    const snapshot = await captureSelection(
      f.cli,
      'fixture',
      await readWorkingChanges(f.cli, 'fixture'),
    );

    await commitSelected(f.cli, 'fixture', snapshot, 'Checked ignores entry');
    expect(await f.runGit(['show', 'HEAD:sample.txt'])).toBe('selected\n');
  },
);

for (const move of ['older', 'sibling'] as const) {
  test(`a reference-transaction hook moving HEAD to a ${move} commit preserves the exact new commit identity and hook stdin`, async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    await writeFile(join(f.root, 'sample.txt'), 'staged\n');
    await f.runGit(['add', '.']);
    await writeFile(join(f.root, 'sample.txt'), 'working\n');
    const tree = (await f.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
    const sibling = (
      await f.runGit(['commit-tree', tree, '-p', f.c, '-m', 'Sibling'])
    ).trim();
    const destination = move === 'older' ? f.a : sibling;
    const hook = join(f.root, '.git', 'hooks', 'reference-transaction');

    await writeFile(
      hook,
      `#!/bin/sh\nif [ "$1" = committed ] && [ ! -f .git/original-new-sha ]; then\n  while read old new ref; do\n    if [ "$ref" = refs/heads/main ]; then\n      printf "%s\\n" "$new" > .git/original-new-sha\n      git update-ref HEAD ${destination}\n    fi\n  done\nelse\n  cat > /dev/null\nfi\n`,
    );
    await chmod(hook, 0o755);
    const previousIndex = await f.runGit(['ls-files', '--stage', '-z']);
    const snapshot = await captureSelection(
      f.cli,
      'fixture',
      await readWorkingChanges(f.cli, 'fixture'),
    );
    let reported = '';

    try {
      await commitSelected(f.cli, 'fixture', snapshot, 'Exact identity');
    } catch (error) {
      assert.ok(error instanceof Error);
      reported = error.message;
    }

    const created = (
      await readFile(join(f.root, '.git', 'original-new-sha'), 'utf8')
    ).trim();

    expect(reported).toContain(`Commit ${created} was created`);
    expect(await f.runGit(['rev-parse', 'HEAD'])).toBe(`${destination}\n`);
    expect(await f.runGit(['ls-files', '--stage', '-z'])).toBe(previousIndex);
    expect(await f.runGit(['show', `${created}:sample.txt`])).toBe('working\n');
  });
}

test.skipIf(process.platform === 'win32')(
  'a hooks path pointing to /dev/null preserves Git’s disabled-hooks behavior',
  async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    await f.runGit(['config', 'core.hooksPath', '/dev/null']);
    await f.runGit([
      'commit',
      '--allow-empty',
      '-m',
      'Ordinary disabled hooks',
    ]);
    await writeFile(join(f.root, 'sample.txt'), 'selected\n');
    const snapshot = await captureSelection(
      f.cli,
      'fixture',
      await readWorkingChanges(f.cli, 'fixture'),
    );

    await commitSelected(f.cli, 'fixture', snapshot, 'Checked disabled hooks');
    expect(await f.runGit(['show', 'HEAD:sample.txt'])).toBe('selected\n');
  },
);
