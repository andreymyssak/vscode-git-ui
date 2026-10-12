import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { assert, expect, onTestFinished, test, vi } from 'vitest';

import type { GitApiAccess, GitRepository } from '../../src/extension/git/api';
import { GitCli } from '../../src/extension/git/cli';
import { withRepositoryOperation } from '../../src/extension/git/repository-operations';
import { createSourceControlBackend } from '../../src/extension/git/source-control/index';
import type { RepositoryInfo } from '../../src/shared/model';
import {
  createSquashFixture,
  squashAccess,
} from '../fixtures/squash-repository';

const host = vi.hoisted(() => ({ access: null as GitApiAccess | null }));

vi.mock('../../src/extension/git/api', () => ({
  getGitApi: async () => {
    if (!host.access) throw new Error('Missing fixture API');

    return host.access;
  },
}));
vi.mock('vscode', () => ({}));

async function fixture() {
  const f = await createSquashFixture();
  const repository = f.access.repository('fixture');
  const listeners = new Set<(repository: GitRepository) => void>();
  const opened = new Set<(repository: GitRepository) => void>();
  let available = true;
  const info: RepositoryInfo = {
    id: 'fixture',
    label: 'Fixture',
    rootUri: repository.rootUri.toString(),
    branch: 'main',
    headSha: f.c,
  };

  host.access = {
    ...f.access,
    api: {
      ...f.access.api,
      onDidOpenRepository: (listener) => {
        opened.add(listener);

        return {
          dispose() {
            opened.delete(listener);
          },
        };
      },
      onDidCloseRepository: (listener) => {
        listeners.add(listener);

        return {
          dispose() {
            listeners.delete(listener);
          },
        };
      },
    },
    repositories: () => (available ? [info] : []),
    repository: (id) => {
      if (!available) throw new Error('Repository closed');

      // VS Code creates a new public API wrapper for each lookup and event.
      return { ...f.access.repository(id) };
    },
  };
  const backend = await createSourceControlBackend();

  onTestFinished(async () => {
    backend.dispose();
    await f.dispose();
  });

  return {
    ...f,
    backend,
    listeners,
    opened,
    closeAndReopen() {
      available = false;
      for (const listener of listeners) listener({ ...repository });
      available = true;
      for (const listener of opened) listener({ ...repository });
    },
    replace() {
      for (const listener of opened) listener({ ...repository });
    },
  };
}

test.each(['commit', 'stash'] as const)(
  'backend %s preserves unchecked staging and working content',
  async (kind) => {
    const f = await fixture();

    await writeFile(join(f.root, 'unchecked.txt'), 'staged\n');
    await f.runGit(['add', 'unchecked.txt']);
    await writeFile(join(f.root, 'unchecked.txt'), 'working\n');
    await writeFile(join(f.root, 'sample.txt'), 'selected\n');
    const files = (await f.backend.workingChanges('fixture')).filter(
      (file) => file.path === 'sample.txt',
    );
    const prepared = await f.backend.prepareChanges({
      id: 'fixture',
      files,
      mode: { kind: 'new' },
    });
    const result = await prepared.write({
      kind,
      message: 'Selected files',
      beforeWrite: () => {},
    });

    expect(await f.runGit(['show', ':unchecked.txt'])).toBe('staged\n');
    expect(await readFile(join(f.root, 'unchecked.txt'), 'utf8')).toBe(
      'working\n',
    );
    expect(await f.runGit(['show', `${result.sha}:sample.txt`])).toBe(
      'selected\n',
    );
  },
);

test('prepared changes reject edits made during confirmation without changing Git state', async () => {
  const f = await fixture();

  await writeFile(join(f.root, 'sample.txt'), 'selected\n');
  const prepared = await f.backend.prepareChanges({
    id: 'fixture',
    files: await f.backend.workingChanges('fixture'),
    mode: { kind: 'new' },
  });

  await writeFile(join(f.root, 'sample.txt'), 'edited during confirmation\n');
  const before = await f.state();

  await expect(
    prepared.write({ kind: 'commit', message: 'Stale', beforeWrite: () => {} }),
  ).rejects.toThrow(/changed/i);
  expect(await f.state()).toEqual(before);
});

test.each(['reopened', 'replaced', 'disposed'] as const)(
  'prepared changes reject a %s backend target',
  async (state) => {
    const f = await fixture();

    await writeFile(join(f.root, 'sample.txt'), 'selected\n');
    const prepared = await f.backend.prepareChanges({
      id: 'fixture',
      files: await f.backend.workingChanges('fixture'),
      mode: { kind: 'new' },
    });
    const before = await f.state();

    if (state === 'reopened') f.closeAndReopen();
    else if (state === 'replaced') f.replace();
    else f.backend.dispose();
    await expect(
      prepared.write({
        kind: 'commit',
        message: 'Stale',
        beforeWrite: () => {},
      }),
    ).rejects.toThrow(/closed|changed|disposed/i);
    expect(await f.state()).toEqual(before);
    if (state === 'disposed') {
      expect(f.listeners.size).toBe(0);
      expect(f.opened.size).toBe(0);
    }
  },
);

test.each(['selection', 'reopened', 'disposed'] as const)(
  'prepared changes wait for a linked-worktree write and reject a %s change',
  async (state) => {
    const f = await fixture();
    const linked = join(f.directory, 'linked');

    await f.runGit(['worktree', 'add', '-b', 'linked', linked, f.c]);
    await writeFile(join(f.root, 'sample.txt'), 'selected\n');
    const prepared = await f.backend.prepareChanges({
      id: 'fixture',
      files: await f.backend.workingChanges('fixture'),
      mode: { kind: 'new' },
    });
    const linkedAccess = squashAccess(linked);
    let release = () => {};

    let entered = () => {};

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lock = withRepositoryOperation(
      new GitCli({
        ...linkedAccess,
        repository: (id) => {
          assert.equal(id, 'linked');

          return linkedAccess.repository('fixture');
        },
      }),
      'linked',
      async () => {
        entered();
        await held;
      },
    );

    await Promise.race([ready, lock]);
    let guarded = false;
    const write = prepared.write({
      kind: 'commit',
      message: 'Queued',
      beforeWrite: () => {
        guarded = true;
        throw new Error('Selection changed while queued');
      },
    });

    try {
      await delay(150);
      expect(guarded).toBe(false);
      if (state === 'reopened') f.closeAndReopen();
      else if (state === 'disposed') f.backend.dispose();
      expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(f.c);
    } finally {
      release();
      await lock;
    }

    await expect(write).rejects.toThrow(
      state === 'selection'
        ? 'Selection changed while queued'
        : /changed|disposed/i,
    );
    expect(guarded).toBe(state === 'selection');
    expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(f.c);
  },
);

test.each(['rollback', 'discard'] as const)(
  'prepared %s rejects a reopened repository without changing files',
  async (kind) => {
    const f = await fixture();

    await writeFile(join(f.root, 'sample.txt'), 'selected\n');
    const prepared =
      kind === 'rollback'
        ? await f.backend.prepareRollback({
            id: 'fixture',
            files: await f.backend.workingChanges('fixture'),
          })
        : await f.backend.prepareDiscard({
            id: 'fixture',
            path: 'sample.txt',
          });
    const before = await f.state();

    f.closeAndReopen();
    await expect(
      prepared.write({
        deleteNewFiles: false,
        useTrash: true,
        beforeWrite: () => {},
      }),
    ).rejects.toThrow(/changed/i);
    expect(await f.state()).toEqual(before);
  },
);

test('saved writes rename a stash without restoring files and reject a closed confirmation', async () => {
  const f = await fixture();

  await writeFile(join(f.root, 'sample.txt'), 'saved\n');
  await f.runGit(['stash', 'push', '-m', 'Original']);
  const stash = (await f.backend.stashes('fixture'))[0];

  assert.ok(stash);
  const prepared = f.backend.prepareStash({ id: 'fixture', sha: stash.sha });
  const next = await prepared.write({
    action: { kind: 'rename', name: 'Renamed' },
    beforeWrite: () => {},
  });
  const renamed = (await f.backend.stashes('fixture'))[0];

  assert.ok(renamed);
  expect(renamed.sha).toBe(next);
  expect(renamed.message).toBe('Renamed');
  expect(renamed.date).toBe(stash.date);
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe('C\n');
  const stale = f.backend.prepareStash({ id: 'fixture', sha: renamed.sha });
  const before = await f.state();

  f.closeAndReopen();
  await expect(
    stale.write({ action: { kind: 'delete' }, beforeWrite: () => {} }),
  ).rejects.toThrow(/closed|changed/i);
  expect(await f.state()).toEqual(before);
});
