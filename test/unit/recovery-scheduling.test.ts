import { expect, test, vi } from 'vitest';

import { createGitAdapter } from '../../src/extension/git/adapter';
import type { GitRepository } from '../../src/extension/git/api';
import type { validateSquash } from '../../src/extension/git/squash';
import { SquashRecovery } from '../../src/extension/git/squash-recovery';
import { deferred } from '../fixtures/deferred';

type RepositoryIdentity = {
  rootUri: Pick<GitRepository['rootUri'], 'toString'>;
};

const host = vi.hoisted(() => ({
  status: new Set<() => void>(),
  opened: new Set<(repository: RepositoryIdentity) => void>(),
  closed: new Set<(repository: RepositoryIdentity) => void>(),
  errors: new Array<string>(),
  validations: new Array<string>(),
}));

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: async (message: string) => {
      host.errors.push(message);
    },
  },
}));
vi.mock('../../src/extension/git/api', () => ({
  getGitApi: async () => ({
    api: {
      git: { path: 'git' },
      onDidOpenRepository(listener: (repository: RepositoryIdentity) => void) {
        host.opened.add(listener);

        return { dispose: () => host.opened.delete(listener) };
      },
      onDidCloseRepository(listener: (repository: RepositoryIdentity) => void) {
        host.closed.add(listener);

        return { dispose: () => host.closed.delete(listener) };
      },
    },
    repository: () => ({
      state: {
        HEAD: undefined,
        worktrees: [],
        remotes: [],
        onDidChange(listener: () => void) {
          host.status.add(listener);

          return { dispose: () => host.status.delete(listener) };
        },
      },
      getRefs: async () => [],
    }),
    repositories: () => [],
  }),
}));
vi.mock('../../src/extension/git/squash-editor', () => ({
  probeSquashRuntime: async () => {},
}));
vi.mock('../../src/extension/git/message-edit', () => ({
  validateMessageEdit: async () => {
    host.validations.push('message');
  },
}));
vi.mock('../../src/extension/git/squash', () => ({
  validateSquash: async (
    ...args: Parameters<typeof validateSquash>
  ): ReturnType<typeof validateSquash> => {
    host.validations.push('squash');

    return {
      ...args[3],
      replayShas: ['older', 'head'],
      oldestToNewest: ['older', 'head'],
      oldestParentSha: 'parent',
      treeSha: 'tree',
      messages: ['older message', 'head message'],
    };
  },
}));

async function fixture(t: { onTestFinished(cleanup: () => void): void }) {
  host.status.clear();
  host.opened.clear();
  host.closed.clear();
  host.errors.length = 0;
  host.validations.length = 0;
  let scans = 0;
  let active = 0;
  let maximumActive = 0;
  let scan: () => Promise<void> = async () => {};

  const reconcile = vi
    .spyOn(SquashRecovery.prototype, 'reconcile')
    .mockImplementation(async () => {
      scans++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        await scan();
      } finally {
        active--;
      }
    });
  const adapter = await createGitAdapter(undefined, {
    runtime: { executable: process.execPath, helperPath: '/unused-helper' },
    storageDirectory: '/unused-recovery',
  });

  adapter.subscribe('fixture', () => {});
  t.onTestFinished(() => {
    adapter.dispose();
    reconcile.mockRestore();
  });

  return {
    adapter,
    get scans() {
      return scans;
    },
    get maximumActive() {
      return maximumActive;
    },
    scan(next: () => Promise<void>) {
      scan = next;
    },
    status() {
      for (const listener of host.status) listener();
    },
    lifecycle() {
      // Only repository identity participates in native lifecycle observation.
      const repository = {
        rootUri: { toString: () => 'fixture' },
      };

      for (const listener of host.closed) listener(repository);
      for (const listener of host.opened) listener(repository);
    },
  };
}

test('native event bursts share one recovery pass and one dirty follow-up', async (t) => {
  const f = await fixture(t);
  const first = deferred<void>();
  const followup = deferred<void>();

  t.onTestFinished(() => {
    first.resolve();
    followup.resolve();
  });
  f.scan(() => (f.scans === 2 ? first.promise : followup.promise));
  f.status();
  await vi.waitFor(() => expect(f.scans).toBe(2));
  for (let index = 0; index < 20; index++) {
    f.status();
    f.lifecycle();
  }

  expect(f.scans).toBe(2);
  expect(f.maximumActive).toBe(1);
  first.resolve();
  await vi.waitFor(() => expect(f.scans).toBe(3));
  followup.resolve();
  await vi.waitFor(() => expect(f.maximumActive).toBe(1));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.scans).toBe(3);
});

test('explicit history preparations await the active scan and its dirty follow-up', async (t) => {
  const f = await fixture(t);
  const first = deferred<void>();
  const followup = deferred<void>();

  t.onTestFinished(() => {
    first.resolve();
    followup.resolve();
  });
  f.scan(() => (f.scans === 2 ? first.promise : followup.promise));
  f.status();
  await vi.waitFor(() => expect(f.scans).toBe(2));
  const message = f.adapter.prepareMessageEdit(
    'fixture',
    'older',
    'main',
    'head',
  );
  const squash = f.adapter.prepareSquash('fixture', {
    shas: ['older', 'head'],
    expectedBranch: 'main',
    expectedHeadSha: 'head',
  });

  f.status();
  expect(host.validations).toEqual([]);
  first.resolve();
  await vi.waitFor(() => expect(f.scans).toBe(3));
  expect(host.validations).toEqual([]);
  expect(f.maximumActive).toBe(1);
  followup.resolve();
  await Promise.all([message, squash]);
  expect(host.validations.sort()).toEqual(['message', 'squash']);
  expect(f.scans).toBe(3);
});

test('disposing during recovery suppresses dirty scans and late failure feedback', async (t) => {
  const f = await fixture(t);
  const held = deferred<void>();

  t.onTestFinished(() => held.resolve());
  f.scan(async () => {
    await held.promise;
    throw new Error('late recovery failure');
  });
  f.status();
  await vi.waitFor(() => expect(f.scans).toBe(2));
  f.status();
  f.adapter.dispose();
  held.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.status();
  f.lifecycle();
  expect(f.scans).toBe(2);
  expect(host.errors).toEqual([]);
});

test('explicit preparations use a dirty follow-up failure instead of an earlier success', async (t) => {
  const f = await fixture(t);
  const first = deferred<void>();
  const followup = deferred<void>();

  t.onTestFinished(() => {
    first.resolve();
    followup.resolve();
  });
  f.scan(async () => {
    if (f.scans === 2) {
      await first.promise;

      return;
    }

    await followup.promise;
    throw new Error('latest recovery failed');
  });
  f.status();
  await vi.waitFor(() => expect(f.scans).toBe(2));
  const preparations = Promise.allSettled([
    f.adapter.prepareMessageEdit('fixture', 'older', 'main', 'head'),
    f.adapter.prepareSquash('fixture', {
      shas: ['older', 'head'],
      expectedBranch: 'main',
      expectedHeadSha: 'head',
    }),
  ]);

  first.resolve();
  await vi.waitFor(() => expect(f.scans).toBe(3));
  expect(host.validations).toEqual([]);
  followup.resolve();
  expect(await preparations).toEqual([
    {
      status: 'rejected',
      reason: expect.objectContaining({
        message: expect.stringContaining('latest recovery failed'),
      }),
    },
    {
      status: 'rejected',
      reason: expect.objectContaining({
        message: expect.stringContaining('latest recovery failed'),
      }),
    },
  ]);
  expect(host.validations).toEqual([]);
  expect(host.errors).toHaveLength(1);
});

test('disposing recovery prevents waiting preparations from resuming or starting another scan', async (t) => {
  const f = await fixture(t);
  const held = deferred<void>();

  t.onTestFinished(() => held.resolve());
  f.scan(() => held.promise);
  f.status();
  await vi.waitFor(() => expect(f.scans).toBe(2));
  const preparation = f.adapter.prepareMessageEdit(
    'fixture',
    'older',
    'main',
    'head',
  );
  const outcome = Promise.allSettled([preparation]);

  f.adapter.dispose();
  held.resolve();
  expect(await outcome).toEqual([
    {
      status: 'rejected',
      reason: expect.objectContaining({
        message: expect.stringContaining('disposed'),
      }),
    },
  ]);
  await expect(
    f.adapter.prepareMessageEdit('fixture', 'older', 'main', 'head'),
  ).rejects.toThrow('disposed');
  expect(host.validations).toEqual([]);
  expect(f.scans).toBe(2);
});

test('repeated recovery failures notify once until a successful scan', async (t) => {
  const f = await fixture(t);

  f.scan(async () => {
    throw new Error('recovery unavailable');
  });
  f.status();
  await vi.waitFor(() => expect(host.errors).toHaveLength(1));
  f.status();
  await vi.waitFor(() => expect(f.scans).toBe(3));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(host.errors).toHaveLength(1);
  f.scan(async () => {});
  f.status();
  await vi.waitFor(() => expect(f.scans).toBe(4));
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.scan(async () => {
    throw new Error('recovery unavailable');
  });
  f.status();
  await vi.waitFor(() => expect(host.errors).toHaveLength(2));
});
