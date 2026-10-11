import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, test } from 'vitest';

import type { GitCommit } from '../../src/extension/git/api';
import type { GitCli } from '../../src/extension/git/cli';
import { createOperations } from '../../src/extension/git/operations';
import type { GitAction, OperationResult } from '../../src/shared/model';
import { configureBranchRepository } from '../fixtures/branch-repository';
import { createSquashFixture } from '../fixtures/squash-repository';

type Kind = 'cherry-pick' | 'drop-commits' | 'edit-commit-message';

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

async function fixture(kind: Kind) {
  const f = await createSquashFixture();
  const repo = configureBranchRepository(f);

  repo.status = async () => {};

  repo.getCommit = async (sha) => {
    const [hash, ...parents] = (
      await f.runGit(['rev-list', '--parents', '-n', '1', sha])
    )
      .trim()
      .split(' ');

    if (!hash) throw new Error('The fixture commit is unavailable.');

    return { hash, parents, message: 'Fixture commit' };
  };

  let source = f.c;

  if (kind === 'cherry-pick') {
    await f.runGit(['switch', '-c', 'source']);
    await writeFile(join(f.root, 'picked.txt'), 'Cherry-pick this file.\n');
    await f.runGit(['add', 'picked.txt']);
    await f.runGit(['commit', '-m', 'Source commit']);
    source = (await f.runGit(['rev-parse', 'HEAD'])).trim();
    await f.runGit(['switch', 'main']);
  }

  const action: GitAction =
    kind === 'cherry-pick'
      ? {
          kind,
          sha: source,
          expectedBranch: 'main',
          expectedHeadSha: f.c,
        }
      : kind === 'drop-commits'
        ? { kind, target: { ...f.target, shas: [f.c] } }
        : {
            kind,
            sha: f.c,
            expectedHeadSha: f.c,
            expectedBranch: 'main',
            message: 'Edited HEAD message\n',
          };
  const next: GitAction = {
    kind: 'create-branch',
    refId: 'refs/heads/retained-branch',
    expectedSha: f.a,
    name: 'next',
  };
  const run = (cli: Pick<GitCli, 'run'>) =>
    createOperations(f.access, cli, {
      updateDiverged: async () => null,
      remoteCheckout: async () => null,
    });
  const isWrite = (args: readonly string[]) =>
    args[0] ===
    (kind === 'cherry-pick'
      ? 'cherry-pick'
      : kind === 'drop-commits'
        ? 'reset'
        : 'commit');

  return { f, repo, source, action, next, run, isWrite };
}

test.each([
  { kind: 'cherry-pick', stage: 'initial' },
  { kind: 'drop-commits', stage: 'initial' },
  { kind: 'edit-commit-message', stage: 'initial' },
  { kind: 'cherry-pick', stage: 'final' },
  { kind: 'drop-commits', stage: 'final' },
  { kind: 'edit-commit-message', stage: 'final' },
] as const)(
  'cancelled $kind releases its held $stage preflight without a late write',
  async ({ kind, stage }) => {
    const {
      f,
      repo,
      source,
      action,
      next,
      run: createRun,
      isWrite,
    } = await fixture(kind);
    const entered = deferred<void>();
    const heldCommit = deferred<GitCommit>();
    const heldPath = deferred<string>();
    const context = new AbortController();
    const getCommit = repo.getCommit;
    const readCommit = await getCommit(stage === 'initial' ? source : 'HEAD');
    let hold = true;
    let final = false;
    let writes = 0;
    let readSignal: AbortSignal | undefined;
    let first: Promise<OperationResult> | undefined;
    let second: Promise<OperationResult> | undefined;

    repo.getCommit = async (sha) => {
      if (kind === 'cherry-pick' && hold && final === (stage === 'final')) {
        hold = false;
        entered.resolve();

        return heldCommit.promise;
      }

      return getCommit(sha);
    };

    const run = createRun({
      run: async (id, args, signal, before, editors) => {
        if (isWrite(args))
          return f.cli.run(
            id,
            args,
            signal,
            async () => {
              final = true;
              await before?.();
              writes++;
            },
            editors,
          );
        if (
          kind !== 'cherry-pick' &&
          hold &&
          final === (stage === 'final') &&
          args.includes('--git-path')
        ) {
          hold = false;
          readSignal = signal;
          entered.resolve();

          return heldPath.promise;
        }

        return f.cli.run(id, args, signal, before, editors);
      },
    });

    try {
      first = run('fixture', action, context.signal);
      await entered.promise;
      context.abort('The selection changed.');
      second = run('fixture', next);
      expect((await outcome(first)).kind).toBe('cancelled');
      expect((await outcome(second)).kind).toBe('success');
      if (kind !== 'cherry-pick') expect(readSignal).toBe(context.signal);
      heldCommit.resolve(readCommit);
      heldPath.resolve(join(f.root, '.git', 'MERGE_HEAD'));
      await delay(0);
      expect(writes).toBe(0);
      expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(f.c);
      expect((await f.runGit(['rev-parse', 'refs/heads/next'])).trim()).toBe(
        f.a,
      );
    } finally {
      heldCommit.resolve(readCommit);
      heldPath.resolve(join(f.root, '.git', 'MERGE_HEAD'));
      await Promise.allSettled([first, second]);
      await f.dispose();
    }
  },
);

test.each(['cherry-pick', 'drop-commits', 'edit-commit-message'] as const)(
  'cancellation after the %s write boundary retains queue ownership and its result',
  async (kind) => {
    const { f, action, next, run: createRun, isWrite } = await fixture(kind);
    const entered = deferred<void>();
    const held = deferred<void>();
    const context = new AbortController();
    let writeSignal: AbortSignal | undefined;
    let first: Promise<OperationResult> | undefined;
    let second: Promise<OperationResult> | undefined;
    const run = createRun({
      run: async (id, args, signal, before, editors) =>
        f.cli.run(
          id,
          args,
          signal,
          isWrite(args)
            ? async () => {
                await before?.();
                writeSignal = signal;
                entered.resolve();
                await held.promise;
              }
            : before,
          editors,
        ),
    });

    try {
      first = run('fixture', action, context.signal);
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
      expect(writeSignal).toBeUndefined();
      expect((await f.runGit(['rev-parse', 'refs/heads/next'])).trim()).toBe(
        f.a,
      );
      if (kind === 'drop-commits')
        expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(f.b);
      else if (kind === 'edit-commit-message')
        expect(await f.runGit(['log', '-1', '--format=%B'])).toBe(
          'Edited HEAD message\n\n',
        );
      else
        expect(await f.runGit(['show', 'HEAD:picked.txt'])).toBe(
          'Cherry-pick this file.\n',
        );
    } finally {
      held.resolve();
      await Promise.allSettled([first, second]);
      await f.dispose();
    }
  },
);
