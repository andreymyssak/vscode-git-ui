import { tmpdir } from 'node:os';

import { expect, test } from 'vitest';

import type {
  GitAPI,
  GitApiAccess,
  GitRef,
  GitRepository,
} from '../../src/extension/git/api';
import type { OperationDialogs } from '../../src/extension/git/operations';
import { createOperations } from '../../src/extension/git/operations';

const sha = 'a'.repeat(40);
const changed = 'b'.repeat(40);

function fixture(dialog: OperationDialogs['remoteCheckout']) {
  let refs: GitRef[] = [
    {
      type: 0,
      name: 'tracking',
      commit: sha,
      upstream: { remote: 'origin', name: 'main' },
    },
    { type: 1, name: 'origin/main', commit: sha, remote: 'origin' },
  ];
  const writes: string[] = [];
  const calls: string[][] = [];
  let fail = false;
  const repo = {
    getRefs: async () => refs,
    getBranch: async (id: string) =>
      refs.find((ref) => `refs/heads/${ref.name ?? ''}` === id)!,
    status: async () => {},
    checkout: async (name: string) => {
      writes.push(name);
      if (fail) throw new Error('Uncertain native write');
    },
    getCommit: async () => ({ hash: sha, parents: [], message: 'fixture' }),
  } as unknown as GitRepository;
  const access: GitApiAccess = {
    api: {} as GitAPI,
    repository: () => repo,
    repositories: () => [],
  };
  const run = createOperations(
    access,
    {
      run: async (_id, args) => {
        if (args.includes('--git-common-dir')) return tmpdir();
        calls.push([...args]);

        return '';
      },
    },
    { updateDiverged: async () => null, remoteCheckout: dialog },
  );

  return {
    run,
    writes,
    calls,
    move: () => {
      refs = refs.map((ref) =>
        ref.type === 1 ? { ...ref, commit: changed } : ref,
      );
    },
    fail: () => {
      fail = true;
    },
  };
}

test('remote checkout offers local tracking branch', async () => {
  const f = fixture(async (ref, locals) => {
    expect(ref.name).toBe('origin/main');
    expect(locals[0]?.name).toBe('tracking');

    return { kind: 'existing', refId: 'refs/heads/tracking', expectedSha: sha };
  });

  expect(
    (
      await f.run('one', {
        kind: 'checkout',
        refId: 'refs/remotes/origin/main',
        expectedSha: sha,
      })
    ).kind,
  ).toBe('success');
  expect(f.writes).toStrictEqual(['tracking']);
});
test('changed target after dialog rejects write', async () => {
  const f = fixture(async () => {
    f.move();

    return { kind: 'existing', refId: 'refs/heads/tracking', expectedSha: sha };
  });

  expect(
    (
      await f.run('one', {
        kind: 'checkout',
        refId: 'refs/remotes/origin/main',
        expectedSha: sha,
      })
    ).kind,
  ).toBe('error');
  expect(f.writes.length).toBe(0);
});
test('cancelled remote dialog performs no writes', async () => {
  const f = fixture(async () => null);

  expect(
    (
      await f.run('one', {
        kind: 'checkout',
        refId: 'refs/remotes/origin/main',
        expectedSha: sha,
      })
    ).kind,
  ).toBe('cancelled');
  expect(f.writes.length).toBe(0);
});
test('uncertain command error is not retried through CLI', async () => {
  const f = fixture(async () => null);

  f.fail();
  expect(
    (
      await f.run('one', {
        kind: 'checkout',
        refId: 'refs/heads/tracking',
        expectedSha: sha,
      })
    ).kind,
  ).toBe('error');
  expect(f.writes.length).toBe(1);
  expect(
    f.calls.filter((args) => args[0] === 'checkout' || args[0] === 'switch')
      .length,
  ).toBe(0);
});
