import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, expect, test } from 'vitest';

import type {
  GitAPI,
  GitApiAccess,
  GitRef,
  GitRepository,
} from '../../src/extension/git/api';
import { createOperations } from '../../src/extension/git/operations';

const sha = 'a'.repeat(40);

async function fixture(
  failure: 'creation' | 'tracking' | 'checkout' | 'verification',
  conflict = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'git-ui-native-completion-'));
  const path = join(directory, 'worktree');
  const writes: string[] = [];
  const refs: GitRef[] = [
    { type: 1, name: 'origin/main', commit: sha, remote: 'origin' },
  ];
  const repo = {
    getRefs: async () => refs,
    status: async () => {},
    createBranch: async (name: string) => {
      if (failure === 'creation') throw new Error('Creation failed');
      writes.push('create');
      refs.push({ type: 0, name, commit: sha });
    },
    createWorktree: async () => {
      if (failure === 'creation') throw new Error('Creation failed');
      await mkdir(path);
      writes.push('create worktree');
      refs.push({ type: 0, name: 'feature', commit: sha });

      return path;
    },
    setBranchUpstream: async () => {
      writes.push('tracking');
      if (failure === 'tracking') throw new Error('Tracking unavailable');
    },
    checkout: async () => {
      writes.push('checkout');
      if (failure === 'checkout')
        throw new Error('Local changes block checkout');
    },
  } as unknown as GitRepository;
  const apiAccess: GitApiAccess = {
    api: {} as GitAPI,
    repository: () => repo,
    repositories: () => [],
  };
  const run = createOperations(
    apiAccess,
    {
      run: async (_id, args) => {
        if (args.includes('--git-common-dir')) return directory;
        if (conflict && args[0] === 'diff') return 'blocked.txt\0';
        if (args.includes('rev-parse')) {
          if (failure === 'verification') throw new Error('Cannot read HEAD');

          return sha;
        }

        return '';
      },
    },
    {
      updateDiverged: async () => null,
      remoteCheckout: async () => ({ kind: 'create', name: 'feature' }),
    },
  );

  return {
    path,
    refs,
    writes,
    checkout: () =>
      run('repo', {
        kind: 'checkout',
        refId: 'refs/remotes/origin/main',
        expectedSha: sha,
      }),
    worktree: () =>
      run('repo', {
        kind: 'create-worktree',
        refId: 'refs/remotes/origin/main',
        expectedSha: sha,
        name: 'feature',
        path,
      }),
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

for (const failure of ['tracking', 'checkout'] as const) {
  test(`remote checkout reports the created branch when ${failure} fails`, async () => {
    const f = await fixture(failure);

    try {
      const result = await f.checkout();

      assert.ok(result.kind === 'error');
      expect(result.message ?? '').toMatch(/Created branch "feature"/);
      expect(result.message ?? '').toMatch(new RegExp(failure, 'i'));
      expect(result.message ?? '').toMatch(
        failure === 'tracking' ? /Tracking unavailable/ : /Local changes/,
      );
      expect(result.message ?? '').not.toMatch(/Refresh before retrying/);
      assert.ok(f.refs.some((ref) => ref.name === 'feature'));
      expect(f.writes).toStrictEqual(
        failure === 'tracking'
          ? ['create', 'tracking']
          : ['create', 'tracking', 'checkout'],
      );
    } finally {
      await f.dispose();
    }
  });
}

test('failed branch creation does not claim that a branch was created', async () => {
  const f = await fixture('creation');

  try {
    const result = await f.checkout();

    assert.ok(result.kind === 'error');
    expect(result.message ?? '').toMatch(/Creation failed/);
    expect(result.message ?? '').not.toMatch(/Created branch/);
    expect(f.writes).toStrictEqual([]);
  } finally {
    await f.dispose();
  }
});
test('partial checkout feedback retains Source Control recovery when Git has conflicts', async () => {
  const f = await fixture('checkout', true);

  try {
    const result = await f.checkout();

    assert.ok(result.kind === 'conflict');
    expect(result.recovery).toBe('source-control');
    expect(result.message ?? '').toMatch(/Created branch "feature"/);
    expect(result.message ?? '').toMatch(/Local changes block checkout/);
    expect(f.writes).toStrictEqual(['create', 'tracking', 'checkout']);
  } finally {
    await f.dispose();
  }
});
test('failed worktree creation does not claim that a worktree was created', async () => {
  const f = await fixture('creation');

  try {
    const result = await f.worktree();

    assert.ok(result.kind === 'error');
    expect(result.message ?? '').toMatch(/Creation failed/);
    expect(result.message ?? '').not.toMatch(/Created worktree/);
    expect(f.writes).toStrictEqual([]);
  } finally {
    await f.dispose();
  }
});
for (const failure of ['tracking', 'verification'] as const) {
  test(`worktree creation reports the existing worktree when ${failure} fails`, async () => {
    const f = await fixture(failure);

    try {
      const result = await f.worktree();

      assert.ok(result.kind === 'error');
      expect(result.message ?? '').toMatch(/Created worktree for "feature"/);
      assert.ok(result.message?.includes(f.path));
      expect(result.message ?? '').toMatch(
        failure === 'tracking' ? /Tracking unavailable/ : /Cannot read HEAD/,
      );
      await access(f.path);
      assert.ok(f.refs.some((ref) => ref.name === 'feature'));
      expect(f.writes).toStrictEqual(
        failure === 'tracking'
          ? ['create worktree', 'tracking']
          : ['create worktree'],
      );
    } finally {
      await f.dispose();
    }
  });
}
