import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, test } from 'vitest';

import { GitCli } from '../../src/extension/git/cli';
import { createOperations } from '../../src/extension/git/operations';
import { withRepositoryOperation } from '../../src/extension/git/repository-operations';
import { configureBranchRepository } from '../../test/fixtures/branch-repository';
import {
  createSquashFixture,
  squashAccess,
} from '../../test/fixtures/squash-repository';

const dialogs = {
  updateDiverged: async () => null,
  remoteCheckout: async () => null,
};

test.each(['source-control', 'log'] as const)(
  'Log writes in a linked worktree wait for a %s write',
  async (owner) => {
    const f = await createSquashFixture();
    const linkedRoot = join(f.directory, 'linked');
    let release = () => {};

    let entered = () => {};

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first: Promise<unknown> | undefined;
    let second: ReturnType<ReturnType<typeof createOperations>> | undefined;

    try {
      await f.runGit(['worktree', 'add', '-b', 'linked', linkedRoot, f.c]);
      const mainRepo = configureBranchRepository(f);
      const linkedAccess = squashAccess(linkedRoot);
      const linkedFixture = {
        ...f,
        root: linkedRoot,
        access: linkedAccess,
        runGit: (args: readonly string[], cwd = linkedRoot) =>
          f.runGit(args, cwd),
      };
      const linkedRepo = configureBranchRepository(linkedFixture);

      linkedRepo.getCommit = async () => ({
        hash: f.c,
        parents: [],
        message: 'Fixture',
      });
      linkedRepo.status = async () => {};

      const access = {
        ...f.access,
        repository: (id: string) => {
          if (id === 'main-root') return mainRepo;
          if (id === 'linked-root') return linkedRepo;
          throw new Error('Unexpected repository');
        },
      };
      const cli = new GitCli(access);
      const events: string[] = [];
      const createBranch = linkedRepo.createBranch;

      linkedRepo.createBranch = async (...args) => {
        events.push('log-write');
        await createBranch(...args);
      };

      const hold = async () => {
        events.push('source-control-write');
        entered();
        await held;
      };

      mainRepo.fetch = hold;
      mainRepo.status = async () => {};

      first =
        owner === 'source-control'
          ? withRepositoryOperation(cli, 'main-root', hold)
          : createOperations(
              access,
              cli,
              dialogs,
            )('main-root', { kind: 'fetch-all' });
      await ready;
      second = createOperations(
        access,
        cli,
        dialogs,
      )('linked-root', {
        kind: 'branch-from-commit',
        sha: f.c,
        name: 'research-created',
      });
      await Promise.race([second, delay(250)]);
      expect(events).toEqual(['source-control-write']);
    } finally {
      release();
      await Promise.allSettled([first, second]);
      await f.dispose();
    }
  },
);

test('a successfully created Git branch stays successful when status refresh fails', async () => {
  const f = await createSquashFixture();

  try {
    const repo = configureBranchRepository(f);

    repo.getCommit = async () => ({
      hash: f.c,
      parents: [],
      message: 'Fixture',
    });
    Object.defineProperty(repo, 'state', {
      value: { HEAD: { type: 0, name: 'main', commit: f.c }, mergeChanges: [] },
    });
    repo.status = async () => {
      throw new Error('Injected refresh failure');
    };

    const result = await createOperations(
      f.access,
      f.cli,
      dialogs,
    )('fixture', {
      kind: 'branch-from-commit',
      sha: f.c,
      name: 'research-success',
    });
    const actualSha = (
      await f.runGit(['rev-parse', 'refs/heads/research-success'])
    ).trim();

    expect(actualSha).toBe(f.c);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success')
      throw new Error('Expected a successful branch creation');
    expect(result.message).toContain('Created branch "research-success".');
    expect(result.message).toContain('could not refresh');
  } finally {
    await f.dispose();
  }
});
