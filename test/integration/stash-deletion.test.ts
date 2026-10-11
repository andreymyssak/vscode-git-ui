import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { TestContext } from 'vitest';
import { assert, expect, test } from 'vitest';

import { GitCli } from '../../src/extension/git/cli';
import { deleteStashEntry } from '../../src/extension/git/delete-stash';
import { deleteStash } from '../../src/extension/git/stash-operations';
import { readStashes } from '../../src/extension/git/stashes';
import {
  createSquashFixture,
  squashAccess,
} from '../fixtures/squash-repository';

async function expectNoDeletionLocks(common: string): Promise<void> {
  for (const path of [
    join(common, 'refs', 'stash.lock'),
    join(common, 'logs', 'refs', 'stash.lock'),
    join(common, 'packed-refs.lock'),
  ])
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function stashFixture(t: TestContext) {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  await writeFile(join(f.root, 'sample.txt'), 'saved working change\n');
  await f.runGit(['stash', 'push', '-m', 'Saved stash']);
  const stash = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(stash);

  return { ...f, stash };
}

test('delete preserves an external stash created after ordinal verification and removes only the confirmed SHA', async (t) => {
  const f = await stashFixture(t);

  await writeFile(join(f.root, 'sample.txt'), 'external recovery data\n');
  const external = (
    await f.runGit(['stash', 'create', 'External stash'])
  ).trim();

  await f.runGit(['restore', '--', 'sample.txt']);
  const before = await f.state();
  const references = await f.runGit(['show-ref', '--heads', '--tags']);
  let injected = false;
  const cli: Pick<GitCli, 'run'> = {
    run: async (id, args, ...options) => {
      const result = await f.cli.run(id, args, ...options);

      if (
        !injected &&
        args[0] === 'rev-parse' &&
        args.includes(f.stash.selector)
      ) {
        injected = true;
        await f.runGit(['stash', 'store', '-m', 'External stash', external]);
      }

      return result;
    },
  };

  await deleteStash(cli, 'fixture', f.stash.sha);
  expect(injected).toBe(true);
  expect((await readStashes(f.cli, 'fixture')).map((item) => item.sha)).toEqual(
    [external],
  );
  expect(await f.runGit(['show', `${external}:sample.txt`])).toBe(
    'external recovery data\n',
  );
  const after = await f.state();

  expect(after.head).toBe(before.head);
  expect(after.index).toBe(before.index);
  expect(after.files).toEqual(before.files);
  expect(await f.runGit(['show-ref', '--heads', '--tags'])).toBe(references);
});

test('delete refuses another process stash lock without changing recovery data or removing its lock', async (t) => {
  const f = await stashFixture(t);
  const lock = join(f.root, '.git', 'refs', 'stash.lock');

  await writeFile(lock, 'external process lock\n');
  const before = await f.state();
  const reflog = await readFile(join(f.root, '.git', 'logs', 'refs', 'stash'));

  await expect(deleteStash(f.cli, 'fixture', f.stash.sha)).rejects.toThrow(
    /lock|busy/i,
  );
  expect(await f.state()).toEqual(before);
  expect(await readFile(join(f.root, '.git', 'logs', 'refs', 'stash'))).toEqual(
    reflog,
  );
  expect(await readFile(lock, 'utf8')).toBe('external process lock\n');
});

for (const position of [0, 1, 2]) {
  test(`delete removes only stash position ${position} and preserves unrelated raw reflog metadata`, async (t) => {
    const f = await stashFixture(t);

    for (const name of ['Middle ü', 'Newest ü']) {
      await writeFile(join(f.root, 'sample.txt'), `${name}\n`);
      await f.runGit(['stash', 'push', '-m', name]);
    }

    const common = join(f.root, '.git');
    const logPath = join(common, 'logs', 'refs', 'stash');
    const original = await readFile(logPath);
    // Git permits opaque message bytes; a rewrite must preserve them, not decode UTF-8.
    const raw = Buffer.concat([
      original.subarray(0, -1),
      Buffer.from([0xfe, 10]),
    ]);

    await writeFile(logPath, raw);
    const stashes = await readStashes(f.cli, 'fixture');
    const target = stashes[position];

    assert.ok(target);
    const before = await f.state();
    const references = await f.runGit(['show-ref', '--heads', '--tags']);
    const remaining = stashes.filter((stash) => stash.sha !== target.sha);
    const keptRaw = raw
      .toString('latin1')
      .trimEnd()
      .split('\n')
      .filter((line) => line.slice(41, 81) !== target.sha);

    await deleteStash(f.cli, 'fixture', target.sha);
    expect(
      (await readStashes(f.cli, 'fixture')).map((stash) => stash.sha),
    ).toEqual(remaining.map((stash) => stash.sha));
    const actual = (await readFile(logPath))
      .toString('latin1')
      .slice(0, -1)
      .split('\n');

    expect(actual.map((line) => line.slice(40))).toEqual(
      keptRaw.map((line) => line.slice(40)),
    );
    expect(actual[0]?.slice(0, 40)).toBe('0'.repeat(40));
    expect(actual[1]?.slice(0, 40)).toBe(actual[0]?.slice(41, 81));
    expect((await f.runGit(['rev-parse', 'refs/stash'])).trim()).toBe(
      remaining[0]?.sha,
    );
    const after = await f.state();

    expect(after.head).toBe(before.head);
    expect(after.index).toBe(before.index);
    expect(after.files).toEqual(before.files);
    expect(await f.runGit(['show-ref', '--heads', '--tags'])).toBe(references);
    await expectNoDeletionLocks(common);
  });
}

test('deleting the final stash blocks a concurrent Git store while holding its lock', async (t) => {
  const f = await stashFixture(t);

  await writeFile(join(f.root, 'sample.txt'), 'external recovery data\n');
  const external = (
    await f.runGit(['stash', 'create', 'External stash'])
  ).trim();

  await f.runGit(['restore', '--', 'sample.txt']);
  const before = await f.state();
  let commonReads = 0;
  let refused = false;
  const cli: Pick<GitCli, 'run'> = {
    run: async (id, args, ...options) => {
      if (args.includes('--git-common-dir') && ++commonReads === 2) {
        await expect(
          f.runGit(['stash', 'store', '-m', 'External stash', external]),
        ).rejects.toThrow(/lock|exists/i);
        refused = true;
      }

      return f.cli.run(id, args, ...options);
    },
  };

  await deleteStash(cli, 'fixture', f.stash.sha);
  expect(refused).toBe(true);
  expect(await readStashes(f.cli, 'fixture')).toEqual([]);
  expect(await f.runGit(['show', `${external}:sample.txt`])).toBe(
    'external recovery data\n',
  );
  const after = await f.state();

  expect(after.head).toBe(before.head);
  expect(after.index).toBe(before.index);
  expect(after.files).toEqual(before.files);
  await expectNoDeletionLocks(join(f.root, '.git'));
});

test('delete preserves a foreign reflog lock and cleans only the locks it acquired', async (t) => {
  const f = await stashFixture(t);
  const common = join(f.root, '.git');
  const lock = join(common, 'logs', 'refs', 'stash.lock');
  const log = join(common, 'logs', 'refs', 'stash');

  await writeFile(lock, 'external reflog lock\n');
  const before = await f.state();
  const raw = await readFile(log);

  await expect(deleteStash(f.cli, 'fixture', f.stash.sha)).rejects.toThrow(
    /lock/i,
  );
  expect(await f.state()).toEqual(before);
  expect(await readFile(log)).toEqual(raw);
  expect(await readFile(lock, 'utf8')).toBe('external reflog lock\n');
  await expect(lstat(join(common, 'refs', 'stash.lock'))).rejects.toMatchObject(
    { code: 'ENOENT' },
  );
  await expect(lstat(join(common, 'packed-refs.lock'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('a failing Git revalidation leaves all recovery bytes intact and releases owned locks', async (t) => {
  const f = await stashFixture(t);
  const common = join(f.root, '.git');
  const log = join(common, 'logs', 'refs', 'stash');
  const before = await f.state();
  const raw = await readFile(log);
  let commonReads = 0;
  const cli: Pick<GitCli, 'run'> = {
    run: async (id, args, ...options) => {
      if (args.includes('--git-common-dir') && ++commonReads === 2)
        throw new Error('Injected Git process failure');

      return f.cli.run(id, args, ...options);
    },
  };

  await expect(deleteStash(cli, 'fixture', f.stash.sha)).rejects.toThrow(
    'Injected Git process failure',
  );
  expect(commonReads).toBe(2);
  expect(await f.state()).toEqual(before);
  expect(await readFile(log)).toEqual(raw);
  await expectNoDeletionLocks(common);
});

test('cleanup preserves a replaced lock, attempts the remaining locks, and reports the original process failure', async (t) => {
  const f = await stashFixture(t);
  const common = join(f.root, '.git');
  const log = join(common, 'logs', 'refs', 'stash');
  const logLock = `${log}.lock`;
  const before = await f.state();
  const raw = await readFile(log);
  let commonReads = 0;
  const cli: Pick<GitCli, 'run'> = {
    run: async (id, args, ...options) => {
      if (args.includes('--git-common-dir') && ++commonReads === 2) {
        await rm(logLock);
        await writeFile(logLock, 'replacement process lock\n');
        throw new Error('Injected Git failure before installation');
      }

      return f.cli.run(id, args, ...options);
    },
  };

  await expect(deleteStash(cli, 'fixture', f.stash.sha)).rejects.toThrow(
    /Injected Git failure.*cleanup/i,
  );
  expect(await f.state()).toEqual(before);
  expect(await readFile(log)).toEqual(raw);
  expect(await readFile(logLock, 'utf8')).toBe('replacement process lock\n');
  await expect(lstat(join(common, 'refs', 'stash.lock'))).rejects.toMatchObject(
    { code: 'ENOENT' },
  );
  await expect(lstat(join(common, 'packed-refs.lock'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('delete refuses malformed surviving reflog lines before promoting their SHA to the stash tip', async (t) => {
  const f = await stashFixture(t);

  await writeFile(join(f.root, 'sample.txt'), 'normal newest stash\n');
  await f.runGit(['stash', 'push', '-m', 'Newest stash']);
  const target = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(target);
  const log = join(f.root, '.git', 'logs', 'refs', 'stash');
  const lines = (await readFile(log, 'utf8')).slice(0, -1).split('\n');

  assert.ok(lines[0]);
  lines[0] = `${lines[0].slice(0, 82)}broken identity and timestamp\tolder recovery entry`;
  await writeFile(log, `${lines.join('\n')}\n`);
  const before = await f.state();
  const raw = await readFile(log);

  await expect(deleteStash(f.cli, 'fixture', target.sha)).rejects.toThrow(
    /reflog.*unsupported format/i,
  );
  expect(await f.state()).toEqual(before);
  expect(await readFile(log)).toEqual(raw);
  expect(
    (await readStashes(f.cli, 'fixture')).map((stash) => stash.sha),
  ).toEqual([target.sha]);
  await expectNoDeletionLocks(join(f.root, '.git'));
});

for (const identity of ['zero', 'unknown', 'blob']) {
  test(`delete refuses an invisible ${identity} reflog identity without replacing the valid stash tip`, async (t) => {
    const f = await stashFixture(t);

    await writeFile(join(f.root, 'sample.txt'), 'wanted newest stash\n');
    await f.runGit(['stash', 'push', '-m', 'Wanted newest stash']);
    const target = (await readStashes(f.cli, 'fixture'))[0];

    assert.ok(target);
    const invisible =
      identity === 'blob'
        ? (await f.runGit(['rev-parse', 'HEAD:sample.txt'])).trim()
        : (identity === 'zero' ? '0' : '1').repeat(40);
    const log = join(f.root, '.git', 'logs', 'refs', 'stash');
    const lines = (await readFile(log, 'utf8')).slice(0, -1).split('\n');

    assert.ok(lines[0]);
    lines[0] = `${lines[0].slice(0, 41)}${invisible}${lines[0].slice(81)}`;
    await writeFile(log, `${lines.join('\n')}\n`);
    const before = await f.state();
    const raw = await readFile(log);

    expect(
      (await readStashes(f.cli, 'fixture')).map((stash) => stash.sha),
    ).toEqual([target.sha]);
    await expect(deleteStash(f.cli, 'fixture', target.sha)).rejects.toThrow(
      /reflog.*Git cannot read safely/i,
    );
    expect(await f.state()).toEqual(before);
    expect(await readFile(log)).toEqual(raw);
    expect((await f.runGit(['rev-parse', 'refs/stash'])).trim()).toBe(
      target.sha,
    );
    await expectNoDeletionLocks(join(f.root, '.git'));
  });
}

test('delete refuses real reftable storage without modifying its recovery entries', async (t) => {
  const f = await stashFixture(t);
  const root = join(f.directory, 'reftable repository');

  await mkdir(root);
  await f.runGit(
    ['init', '--initial-branch=main', '--ref-format=reftable'],
    root,
  );
  await f.runGit(['config', 'user.name', 'Stash Fixture'], root);
  await f.runGit(['config', 'user.email', 'stash@example.test'], root);
  await writeFile(join(root, 'sample.txt'), 'base\n');
  await f.runGit(['add', '.'], root);
  await f.runGit(['commit', '-m', 'Base'], root);
  await writeFile(join(root, 'sample.txt'), 'saved\n');
  await f.runGit(['stash', 'push', '-m', 'Reftable stash'], root);
  const cli = new GitCli(squashAccess(root));
  const target = (await readStashes(cli, 'fixture'))[0];

  assert.ok(target);
  const before = await f.state(root);

  await expect(deleteStash(cli, 'fixture', target.sha)).rejects.toThrow(
    /files-based refs/i,
  );
  expect(await f.state(root)).toEqual(before);
  expect((await readStashes(cli, 'fixture')).map((stash) => stash.sha)).toEqual(
    [target.sha],
  );
});

test('delete refuses packed stash refs without removing any recovery entry', async (t) => {
  const f = await stashFixture(t);

  await f.runGit(['pack-refs', '--all']);
  const before = await f.state();
  const packed = await readFile(join(f.root, '.git', 'packed-refs'));
  const log = await readFile(join(f.root, '.git', 'logs', 'refs', 'stash'));

  await expect(deleteStash(f.cli, 'fixture', f.stash.sha)).rejects.toThrow(
    /packed.*stash|stash.*packed/i,
  );
  expect(await f.state()).toEqual(before);
  expect(await readFile(join(f.root, '.git', 'packed-refs'))).toEqual(packed);
  expect(await readFile(join(f.root, '.git', 'logs', 'refs', 'stash'))).toEqual(
    log,
  );
  await expectNoDeletionLocks(join(f.root, '.git'));
});

test('delete refuses duplicate stash identities rather than choosing a different recovery entry', async (t) => {
  const f = await stashFixture(t);

  await writeFile(join(f.root, 'sample.txt'), 'newer stash\n');
  await f.runGit(['stash', 'push', '-m', 'Intervening stash']);
  await f.runGit([
    'stash',
    'store',
    '-m',
    'Same commit saved again',
    f.stash.sha,
  ]);
  const before = await f.state();
  const log = await readFile(join(f.root, '.git', 'logs', 'refs', 'stash'));

  await expect(deleteStash(f.cli, 'fixture', f.stash.sha)).rejects.toThrow(
    /more than once/i,
  );
  expect(await f.state()).toEqual(before);
  expect(await readFile(join(f.root, '.git', 'logs', 'refs', 'stash'))).toEqual(
    log,
  );
  await expectNoDeletionLocks(join(f.root, '.git'));
});

test.skipIf(process.platform === 'win32')(
  'delete refuses a symbolic reflog file without changing its target',
  async (t) => {
    const f = await stashFixture(t);
    const log = join(f.root, '.git', 'logs', 'refs', 'stash');
    const target = join(f.root, '.git', 'original-stash-log');
    const raw = await readFile(log);

    await rename(log, target);
    await symlink(target, log);
    const before = await f.state();

    await expect(
      deleteStashEntry(f.cli, 'fixture', f.stash.sha),
    ).rejects.toThrow(/symbolic link/i);
    expect(await f.state()).toEqual(before);
    expect((await lstat(log)).isSymbolicLink()).toBe(true);
    expect(await readFile(target)).toEqual(raw);
    await expectNoDeletionLocks(join(f.root, '.git'));
  },
);

test('final deletion uses per-worktree hook configuration and refuses to bypass a transaction hook', async (t) => {
  const f = await stashFixture(t);
  const worktree = join(f.directory, 'linked worktree ü');

  await f.runGit(['worktree', 'add', '-b', 'linked-stash-test', worktree]);
  await f.runGit(['config', 'extensions.worktreeConfig', 'true']);
  await f.runGit(
    ['config', '--worktree', 'core.hooksPath', 'local-hooks'],
    worktree,
  );
  const hooks = join(worktree, 'local-hooks');
  const hook = join(hooks, 'reference-transaction');

  await mkdir(hooks);
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  const cli = new GitCli(squashAccess(worktree));
  const before = await f.state(worktree);
  const raw = await readFile(join(f.root, '.git', 'logs', 'refs', 'stash'));

  await expect(deleteStash(cli, 'fixture', f.stash.sha)).rejects.toThrow(
    /reference-transaction hook/i,
  );
  expect(await f.state(worktree)).toEqual(before);
  expect(await readFile(join(f.root, '.git', 'logs', 'refs', 'stash'))).toEqual(
    raw,
  );
  expect(await readFile(hook, 'utf8')).toBe('#!/bin/sh\nexit 1\n');
  await expectNoDeletionLocks(join(f.root, '.git'));
});

test.skipIf(process.platform === 'win32')(
  'final deletion supports hooks disabled with core.hooksPath=/dev/null',
  async (t) => {
    const f = await stashFixture(t);

    await f.runGit(['config', 'core.hooksPath', '/dev/null']);
    await deleteStash(f.cli, 'fixture', f.stash.sha);
    expect(await readStashes(f.cli, 'fixture')).toEqual([]);
    await expectNoDeletionLocks(join(f.root, '.git'));
  },
);

test('deleting the newest entry with other stashes matches Git and does not invoke transaction hooks', async (t) => {
  const f = await stashFixture(t);

  for (const name of ['Second', 'Third']) {
    await writeFile(join(f.root, 'sample.txt'), `${name}\n`);
    await f.runGit(['stash', 'push', '-m', name]);
  }

  const record = join(f.directory, 'transaction-hook-ran');
  const hooks = join(f.root, '.git', 'hooks');
  const hook = join(hooks, 'reference-transaction');

  await writeFile(
    hook,
    `#!/bin/sh\nprintf '%s\\n' "$1" > '${record.replaceAll("'", "'\\''")}'\nexit 1\n`,
  );
  await chmod(hook, 0o755);
  await f.runGit(['stash', 'drop', 'stash@{0}']);
  await expect(lstat(record)).rejects.toMatchObject({ code: 'ENOENT' });
  const target = (await readStashes(f.cli, 'fixture'))[0];

  assert.ok(target);
  expect(target.sha).not.toBe(f.stash.sha);
  await deleteStash(f.cli, 'fixture', target.sha);
  expect(
    (await readStashes(f.cli, 'fixture')).map((stash) => stash.sha),
  ).toEqual([f.stash.sha]);
  await expect(lstat(record)).rejects.toMatchObject({ code: 'ENOENT' });
  await expectNoDeletionLocks(join(f.root, '.git'));
});

test('delete from a linked worktree uses the canonical shared stash storage', async (t) => {
  const f = await stashFixture(t);
  const worktree = join(f.directory, 'linked stash worktree ü');

  await f.runGit(['worktree', 'add', '-b', 'linked-delete-test', worktree]);
  const cli = new GitCli(squashAccess(worktree));
  const before = await f.state(worktree);

  await deleteStash(cli, 'fixture', f.stash.sha);
  expect(await readStashes(f.cli, 'fixture')).toEqual([]);
  const after = await f.state(worktree);

  expect(after.head).toBe(before.head);
  expect(after.index).toBe(before.index);
  expect(after.files).toEqual(before.files);
  await expectNoDeletionLocks(join(f.root, '.git'));
});
