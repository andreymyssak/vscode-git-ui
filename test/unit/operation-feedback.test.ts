import { assert, expect, test } from 'vitest';

import { publishOperationResult } from '../../src/extension/panel/actions';

for (const kind of [
  'update-branch',
  'merge-branch',
  'rebase-branch',
  'create-worktree',
] as const) {
  test(`${kind} summaries appear independently of a closed panel`, async () => {
    const notices: string[] = [];
    const result = {
      kind: 'success' as const,
      backend: 'cli' as const,
      message: '"main" is already up to date.',
    };

    await publishOperationResult(result, kind, {
      current: () => false,
      refresh: async () => assert.fail('The panel is closed'),
      send: async () => assert.fail('The panel is closed'),
      reportError: async () => assert.fail('Success is not an error'),
      reportInfo: async (message: string) => {
        notices.push(message);
      },
    });
    expect(notices).toStrictEqual([result.message]);
  });
}

for (const kind of [
  'update-branch',
  'merge-branch',
  'rebase-branch',
  'fetch-all',
  'checkout',
  'rename-branch',
  'delete-branch',
  'create-branch',
  'copy-sha',
  'copy-branch',
] as const) {
  for (const result of [
    {
      kind: 'error',
      backend: 'cli',
      message: 'Commit or stash local changes before updating.',
      recovery: 'source-control',
    },
    {
      kind: 'conflict',
      backend: 'api',
      message: 'Resolve conflicts in Source Control.',
    },
  ] as const) {
    test(`${kind} ${result.kind} offers Source Control before a pending refresh`, async (t) => {
      const notices: unknown[] = [];
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const done = publishOperationResult(result, kind, {
        current: () => true,
        refresh: () => pending,
        send: async () => {},
        reportError: async (message: string, recovery?: boolean) => {
          notices.push({ message, recovery });
        },
      });

      t.onTestFinished(async () => {
        release();
        await done;
      });
      expect(notices).toStrictEqual([
        { message: result.message, recovery: true },
      ]);
      release();
      await done;
    });
  }
}

test('Cancel and other actions do not create Update success notifications', async () => {
  for (const [kind, result] of [
    ['update-branch', { kind: 'cancelled', backend: null }],
    ['checkout', { kind: 'success', backend: 'api', message: 'Other action' }],
  ] as const)
    await publishOperationResult(result, kind, {
      current: () => false,
      refresh: async () => {},
      send: async () => {},
      reportError: async () => assert.fail('No Update error'),
      reportInfo: async () => assert.fail('No Update result'),
    });
});
