import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, test } from 'vitest';

import type { GitRef } from '../../src/extension/git/api';
import type { GitCli } from '../../src/extension/git/cli';
import { createOperations } from '../../src/extension/git/operations';
import type { GitAction, OperationResult } from '../../src/shared/model';
import { configureBranchRepository } from '../fixtures/branch-repository';
import type { SquashFixture } from '../fixtures/squash-repository';
import { createSquashFixture } from '../fixtures/squash-repository';

type Kind = 'merge-branch' | 'rebase-branch' | 'create-worktree';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

async function outcome(operation: Promise<OperationResult>) {
  return Promise.race([
    operation,
    delay(500).then(() => ({ kind: 'timeout' })),
  ]);
}

function request(f: SquashFixture, kind: Kind): GitAction {
  const source = { refId: 'refs/heads/retained-branch', expectedSha: f.a };

  return kind === 'create-worktree'
    ? {
        ...source,
        kind,
        name: 'created-worktree',
        path: join(f.directory, 'created-worktree'),
      }
    : { ...source, kind, expectedBranch: 'main', expectedHeadSha: f.c };
}

function fixture(f: SquashFixture) {
  const repo = configureBranchRepository(f);
  const writes: Kind[] = [];

  repo.status = async () => {};

  repo.merge = async (sha) => {
    writes.push('merge-branch');
    await f.runGit(['merge', '--no-edit', sha]);
  };

  repo.rebase = async (sha) => {
    writes.push('rebase-branch');
    await f.runGit(['rebase', sha]);
  };

  repo.createWorktree = async (options) => {
    if (!options?.path || !options.branch || !options.commitish)
      throw new Error('The fixture requires a new branch and worktree path.');
    writes.push('create-worktree');
    await f.runGit([
      'worktree',
      'add',
      '-b',
      options.branch,
      options.path,
      options.commitish,
    ]);

    return options.path;
  };

  const run = (cli: Pick<GitCli, 'run'> = f.cli) =>
    createOperations(f.access, cli, {
      updateDiverged: async () => null,
      remoteCheckout: async () => null,
    });
  const next: GitAction = {
    kind: 'create-branch',
    refId: 'refs/heads/main',
    expectedSha: f.c,
    name: 'next',
  };

  return { repo, writes, run, next };
}

test.each(['merge-branch', 'rebase-branch', 'create-worktree'] as const)(
  'cancelled %s releases its held native reference read without a late write',
  async (kind) => {
    const f = await createSquashFixture();
    const { repo, writes, run: createRun, next } = fixture(f);
    const references = await repo.getRefs({});
    const held = deferred<GitRef[]>();
    const entered = deferred<void>();
    const context = new AbortController();
    const getRefs = repo.getRefs;
    let hold = true;
    let first: Promise<OperationResult> | undefined;
    let second: Promise<OperationResult> | undefined;

    repo.getRefs = async (query) => {
      if (!hold) return getRefs(query);
      hold = false;
      entered.resolve();

      return held.promise;
    };

    const run = createRun();

    try {
      first = run('fixture', request(f, kind), context.signal);
      await entered.promise;
      context.abort();
      second = run('fixture', next);
      expect((await outcome(first)).kind).toBe('cancelled');
      expect((await outcome(second)).kind).toBe('success');
      expect((await f.runGit(['rev-parse', 'refs/heads/next'])).trim()).toBe(
        f.c,
      );
      held.resolve(references);
      await delay(0);
      expect(writes).toEqual([]);
      expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(f.c);
      expect(await f.runGit(['worktree', 'list', '--porcelain'])).not.toContain(
        join(f.directory, 'created-worktree'),
      );
    } finally {
      held.resolve(references);
      await Promise.allSettled([first, second]);
      await f.dispose();
    }
  },
);

test.each(['merge-branch', 'rebase-branch', 'create-worktree'] as const)(
  'cancelled %s releases its held CLI preflight and propagates its signal',
  async (kind) => {
    const f = await createSquashFixture();
    const { writes, run: createRun, next } = fixture(f);
    const held = deferred<string>();
    const entered = deferred<void>();
    const context = new AbortController();
    let hold = true;
    let readSignal: AbortSignal | undefined;
    let first: Promise<OperationResult> | undefined;
    let second: Promise<OperationResult> | undefined;
    const run = createRun({
      run: async (id, args, signal) => {
        if (
          hold &&
          args[0] ===
            (kind === 'create-worktree' ? 'check-ref-format' : 'symbolic-ref')
        ) {
          hold = false;
          readSignal = signal;
          entered.resolve();

          return held.promise;
        }

        return f.cli.run(id, args, signal);
      },
    });

    try {
      first = run('fixture', request(f, kind), context.signal);
      await entered.promise;
      context.abort();
      second = run('fixture', next);
      expect((await outcome(first)).kind).toBe('cancelled');
      expect((await outcome(second)).kind).toBe('success');
      expect(readSignal).toBe(context.signal);
      held.resolve(kind === 'create-worktree' ? '' : 'refs/heads/main\n');
      await delay(0);
      expect(writes).toEqual([]);
    } finally {
      held.resolve(kind === 'create-worktree' ? '' : 'refs/heads/main\n');
      await Promise.allSettled([first, second]);
      await f.dispose();
    }
  },
);

test.each(['merge-branch', 'rebase-branch', 'create-worktree'] as const)(
  'cancellation after the %s mutation starts retains queue ownership',
  async (kind) => {
    const f = await createSquashFixture();
    const { repo, writes, run: createRun, next } = fixture(f);
    const held = deferred<void>();
    const entered = deferred<void>();
    const context = new AbortController();
    const merge = repo.merge;
    const rebase = repo.rebase;
    const createWorktree = repo.createWorktree;
    const pause = async () => {
      entered.resolve();
      await held.promise;
    };

    if (kind === 'merge-branch')
      repo.merge = async (...args) => {
        await pause();
        await merge(...args);
      };
    else if (kind === 'rebase-branch')
      repo.rebase = async (...args) => {
        await pause();
        await rebase(...args);
      };
    else
      repo.createWorktree = async (...args) => {
        await pause();

        return createWorktree(...args);
      };

    let first: Promise<OperationResult> | undefined;
    let second: Promise<OperationResult> | undefined;
    const run = createRun();

    try {
      first = run('fixture', request(f, kind), context.signal);
      await entered.promise;
      context.abort();
      second = run('fixture', next);
      expect((await outcome(first)).kind).toBe('timeout');
      expect(
        await f.runGit([
          'for-each-ref',
          '--format=%(refname)',
          'refs/heads/next',
        ]),
      ).toBe('');
      held.resolve();
      expect((await first).kind).toBe('success');
      expect((await second).kind).toBe('success');
      expect(writes).toEqual([kind]);
      expect((await f.runGit(['rev-parse', 'refs/heads/next'])).trim()).toBe(
        f.c,
      );
      if (kind === 'create-worktree')
        expect(
          (
            await f.runGit(
              ['rev-parse', 'HEAD'],
              join(f.directory, 'created-worktree'),
            )
          ).trim(),
        ).toBe(f.a);
    } finally {
      held.resolve();
      await Promise.allSettled([first, second]);
      await f.dispose();
    }
  },
);
