import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import type { GitCommit } from '../../src/extension/git/api';
import { createOperations } from '../../src/extension/git/operations';
import type { OperationResult } from '../../src/shared/model';
import { configureBranchRepository } from '../fixtures/branch-repository';
import { createSquashFixture } from '../fixtures/squash-repository';

const dialogs = {
  updateDiverged: async () => null,
  remoteCheckout: async () => null,
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  let reject: (reason: Error) => void = () => {};

  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
}

async function outcome(operation: Promise<OperationResult>, timeout = 500) {
  return Promise.race([
    operation,
    delay(timeout).then(() => ({ kind: 'timeout' })),
  ]);
}

test.each([
  { completion: 'resolve', reason: undefined },
  { completion: 'reject', reason: undefined },
  { completion: 'resolve', reason: 'The selection changed.' },
] as const)(
  'cancelled native preflight releases the write queue before its late $completion (reason: $reason)',
  async ({ completion, reason }) => {
    const f = await createSquashFixture();
    const repo = configureBranchRepository(f);
    const pending = deferred<GitCommit>();
    const entered = deferred<void>();
    const context = new AbortController();
    const run = createOperations(f.access, f.cli, dialogs);
    let first: Promise<OperationResult> | undefined;
    let second: Promise<OperationResult> | undefined;

    repo.getCommit = async () => {
      entered.resolve();

      return pending.promise;
    };

    repo.status = async () => {};

    try {
      first = run(
        'fixture',
        { kind: 'branch-from-commit', sha: f.c, name: 'cancelled' },
        context.signal,
      );
      await entered.promise;
      context.abort(reason);
      second = run('fixture', {
        kind: 'create-branch',
        refId: 'refs/heads/main',
        expectedSha: f.c,
        name: 'after-cancel',
      });
      expect((await outcome(first)).kind).toBe('cancelled');
      expect((await outcome(second)).kind).toBe('success');
      expect(
        (await f.runGit(['rev-parse', 'refs/heads/after-cancel'])).trim(),
      ).toBe(f.c);
      if (completion === 'resolve')
        pending.resolve({ hash: f.c, parents: [f.b], message: 'C' });
      else pending.reject(new Error('The abandoned native read failed.'));
      await delay(0);
      expect(
        (
          await f.runGit([
            'for-each-ref',
            '--format=%(refname)',
            'refs/heads/cancelled',
          ])
        ).trim(),
      ).toBe('');
    } finally {
      pending.resolve({ hash: f.c, parents: [f.b], message: 'C' });
      await Promise.allSettled([first, second]);
      await f.dispose();
    }
  },
);

test.each(['reference-name', 'common-directory'] as const)(
  'cancelled %s CLI preflight stops its read child and lets the next write proceed',
  async (readStage) => {
    const f = await createSquashFixture();
    const repo = configureBranchRepository(f);
    const context = new AbortController();
    const helper = join(f.directory, 'held-read.cjs');
    const enteredPath = join(f.directory, 'entered.json');
    const releasePath = join(f.directory, 'release');
    const nextEntered = deferred<void>();
    const releaseWrite = deferred<void>();
    const createBranch = repo.createBranch;
    let first: Promise<OperationResult> | undefined;
    let second: Promise<OperationResult> | undefined;

    repo.getCommit = async (hash) => ({ hash, parents: [], message: 'C' });
    repo.status = async () => {};

    repo.createBranch = async (...args) => {
      nextEntered.resolve();
      await releaseWrite.promise;
      await createBranch(...args);
    };

    await writeFile(
      helper,
      `const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = [require('node:path').basename(process.argv[1]), ...process.argv.slice(2)];
if ((${readStage === 'common-directory' ? "args.includes('--git-common-dir')" : "args[0] === 'check-ref-format' && args[1] === 'refs/heads/cancelled'"}) && !fs.existsSync(${JSON.stringify(enteredPath)})) {
  fs.writeFileSync(${JSON.stringify(enteredPath)}, JSON.stringify({ pid: process.pid }));
  while (!fs.existsSync(${JSON.stringify(releasePath)}))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  process.exit(0);
} else {
  process.stdout.write(execFileSync('git', args));
  process.exit(0);
}
`,
    );
    vi.stubEnv('NODE_OPTIONS', `--require ${JSON.stringify(helper)}`);
    Object.assign(f.access.api.git, { path: process.execPath });
    const run = createOperations(f.access, f.cli, dialogs);

    try {
      first = run(
        'fixture',
        { kind: 'branch-from-commit', sha: f.c, name: 'cancelled' },
        context.signal,
      );
      let pid = 0;

      await vi.waitFor(async () => {
        const marker = z
          .object({ pid: z.number().int().positive() })
          .parse(JSON.parse(await readFile(enteredPath, 'utf8')));

        pid = marker.pid;
      });
      context.abort(new Error('The selection changed.'));
      second = run('fixture', {
        kind: 'create-branch',
        refId: 'refs/heads/main',
        expectedSha: f.c,
        name: 'after-cancel',
      });
      expect((await outcome(first)).kind).toBe('cancelled');
      expect(
        await Promise.race([
          nextEntered.promise.then(() => true),
          delay(5000).then(() => false),
        ]),
      ).toBe(true);
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
      });
      releaseWrite.resolve();
      expect((await outcome(second, 5000)).kind).toBe('success');
      expect(
        (await f.runGit(['rev-parse', 'refs/heads/after-cancel'])).trim(),
      ).toBe(f.c);
      expect(
        (
          await f.runGit([
            'for-each-ref',
            '--format=%(refname)',
            'refs/heads/cancelled',
          ])
        ).trim(),
      ).toBe('');
    } finally {
      releaseWrite.resolve();
      await writeFile(releasePath, 'release');
      await Promise.allSettled([first, second]);
      vi.unstubAllEnvs();
      await rm(helper, { force: true });
      await f.dispose();
    }
  },
);

test('cancellation after a branch write starts retains its queue ownership and successful result', async () => {
  const f = await createSquashFixture();
  const repo = configureBranchRepository(f);
  const held = deferred<void>();
  const entered = deferred<void>();
  const context = new AbortController();
  const createBranch = repo.createBranch;
  const run = createOperations(f.access, f.cli, dialogs);
  let first: Promise<OperationResult> | undefined;
  let second: Promise<OperationResult> | undefined;

  repo.getCommit = async (hash) => ({ hash, parents: [], message: 'C' });
  repo.status = async () => {};

  repo.createBranch = async (...args) => {
    if (args[0] === 'started') {
      entered.resolve();
      await held.promise;
    }

    await createBranch(...args);
  };

  try {
    first = run(
      'fixture',
      { kind: 'branch-from-commit', sha: f.c, name: 'started' },
      context.signal,
    );
    await entered.promise;
    context.abort();
    second = run('fixture', {
      kind: 'create-branch',
      refId: 'refs/heads/main',
      expectedSha: f.c,
      name: 'next',
    });
    expect((await outcome(first)).kind).toBe('timeout');
    expect(
      (
        await f.runGit([
          'for-each-ref',
          '--format=%(refname)',
          'refs/heads/next',
        ])
      ).trim(),
    ).toBe('');
    held.resolve();
    expect((await first).kind).toBe('success');
    expect((await second).kind).toBe('success');
    expect((await f.runGit(['rev-parse', 'refs/heads/started'])).trim()).toBe(
      f.c,
    );
  } finally {
    held.resolve();
    await Promise.allSettled([first, second]);
    await f.dispose();
  }
});
