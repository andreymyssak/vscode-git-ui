import { assert, expect, onTestFinished, test } from 'vitest';

import type { RequestBody } from '../../src/shared/messages';
import { a, b, fixture, page } from '../fixtures/controller';

test.each(['create-branch', 'create-branch-checkout'] as const)(
  '%s captures the selected reference before asking for its name',
  async (kind) => {
    const promptModes: boolean[] = [];
    const f = fixture(true, true, {
      askBranchName: async (checkout = false) => {
        promptModes.push(checkout);

        return 'topic';
      },
    });

    onTestFinished(() => f.controller.dispose());
    await f.controller.selectRepository('one');
    await f.controller.handle(
      f.request({ kind: 'action', action: { kind, refId: 'refs/heads/main' } }),
    );
    expect(promptModes).toEqual([kind === 'create-branch-checkout']);
    expect(f.writes).toStrictEqual([
      {
        id: 'one',
        action: {
          kind,
          refId: 'refs/heads/main',
          expectedSha: a,
          name: 'topic',
        },
      },
    ]);
  },
);

test.each(['create-branch', 'create-branch-checkout'] as const)(
  'cancelling the %s name prompt performs no write',
  async (kind) => {
    const f = fixture(true, true, { askBranchName: async () => null });

    onTestFinished(() => f.controller.dispose());
    await f.controller.selectRepository('one');
    await f.controller.handle(
      f.request({ kind: 'action', action: { kind, refId: 'refs/heads/main' } }),
    );
    expect(f.writes).toStrictEqual([]);
  },
);

test('editing captures the displayed latest commit before the message editor opens', async (t) => {
  const f = fixture(true, true, {
    askCommitMessage: async (message: string) => `${message}\n\nEdited body`,
  });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'edit-commit-message', sha: a },
    } as RequestBody),
  );
  expect(f.writes).toStrictEqual([
    {
      id: 'one',
      action: {
        kind: 'edit-commit-message',
        expectedHeadSha: a,
        sha: a,
        expectedBranch: 'main',
        message: `${a}\n\nEdited body`,
      },
    },
  ]);
});

test('cancelled older and latest message editors perform no writes', async (t) => {
  let opened = 0;
  const f = fixture(true, true, {
    askCommitMessage: async () => {
      opened++;

      return null;
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  for (const sha of [b, a])
    await f.controller.handle(
      f.request({
        kind: 'action',
        action: { kind: 'edit-commit-message', sha },
      } as RequestBody),
    );
  expect(opened).toBe(2);
  expect(f.writes.length).toBe(0);
});

test('switching repositories while a message editor is open cancels the pending write', async (t) => {
  const notifications: string[] = [];
  let finish!: (message: string) => void;
  const editor = new Promise<string>((resolve) => {
    finish = resolve;
  });
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const f = fixture(true, true, {
    askCommitMessage: () => {
      opened();

      return editor;
    },
    reportActionError: async (message: string) => {
      notifications.push(message);
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  const action = f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'edit-commit-message', sha: a },
    }),
  );

  t.onTestFinished(async () => {
    finish('Changed message');
    await action;
  });
  await ready;
  await f.controller.selectRepository('two');
  finish('Changed message');
  await action;
  expect(f.writes.length).toBe(0);
  expect(notifications.length).toBe(1);
  expect(notifications[0]!).toMatch(/history changed/i);
});

test('a repository switch queued by the closing message editor cannot write into its old context', async (t) => {
  const notifications: string[] = [];
  let switching: Promise<void> | null = null;
  const f = fixture(true, true, {
    askCommitMessage: async () => {
      queueMicrotask(() => {
        switching = f.controller.selectRepository('two');
      });

      return 'Edited message';
    },
    reportActionError: async (message) => {
      notifications.push(message);
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'edit-commit-message', sha: a },
    }),
  );
  await switching;
  expect(f.writes).toStrictEqual([]);
  expect(notifications.length).toBe(1);
  expect(notifications[0]!).toMatch(/history changed/i);
  f.controller.dispose();
});

test('rename prompts for the selected local branch and retains its exact target', async (t) => {
  let target = '';
  const f = fixture(true, true, {
    askRenameBranch: async (name) => {
      target = name;

      return 'renamed';
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'rename-branch', refId: 'refs/heads/main' },
    }),
  );
  expect(target).toBe('main');
  expect(f.writes).toStrictEqual([
    {
      id: 'one',
      action: {
        kind: 'rename-branch',
        refId: 'refs/heads/main',
        expectedSha: a,
        name: 'renamed',
      },
    },
  ]);
});

test('cancelled branch rename performs no writes', async (t) => {
  const f = fixture(true, true, {
    askRenameBranch: async () => null,
  });

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.selectRepository('one');
  f.sent.length = 0;
  await f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'rename-branch', refId: 'refs/heads/main' },
    }),
  );
  expect(f.writes.length).toBe(0);
  assert.ok(!f.sent.some((message) => message.body.kind === 'error'));
});

test('direct deletion captures the selected local branch tip before writing', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async () => ({
    ...page([a]),
    refs: [
      ...page([]).refs,
      {
        id: 'refs/heads/topic',
        name: 'topic',
        kind: 'local',
        sha: b,
        remote: null,
      },
    ],
  });
  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'delete-branch', refId: 'refs/heads/topic' },
    }),
  );
  expect(f.writes).toStrictEqual([
    {
      id: 'one',
      action: {
        kind: 'delete-branch',
        refId: 'refs/heads/topic',
        expectedSha: b,
      },
    },
  ]);
});
