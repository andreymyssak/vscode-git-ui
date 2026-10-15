import { expect, test } from 'vitest';

import type { HistoryPage } from '../../src/shared/model';
import { a, fixture, page } from '../fixtures/controller';

test('Update derives owned tip and upstream for any displayed tracked local branch', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async () => ({
    ...page([a]),
    refs: [
      {
        id: 'refs/heads/main',
        name: 'main',
        kind: 'local',
        sha: a,
        remote: null,
        tracking: { upstream: 'refs/remotes/origin/main', ahead: 0, behind: 1 },
      },
      {
        id: 'refs/heads/topic',
        name: 'topic',
        kind: 'local',
        sha: a,
        remote: null,
        tracking: {
          upstream: 'refs/remotes/origin/topic',
          ahead: 0,
          behind: 1,
        },
      },
    ],
  });
  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'update-branch', refId: 'refs/heads/topic' },
    }),
  );
  await f.controller.handle(
    f.request(
      {
        kind: 'action',
        action: { kind: 'update-branch', refId: 'refs/heads/main' },
      },
      'one',
      2,
    ),
  );
  expect(f.writes).toStrictEqual([
    {
      id: 'one',
      action: {
        kind: 'update-branch',
        refId: 'refs/heads/topic',
        expectedSha: a,
        expectedUpstream: 'refs/remotes/origin/topic',
      },
    },
    {
      id: 'one',
      action: {
        kind: 'update-branch',
        refId: 'refs/heads/main',
        expectedSha: a,
        expectedUpstream: 'refs/remotes/origin/main',
      },
    },
  ]);
  f.controller.dispose();
});

for (const kind of ['conflict', 'error'] as const) {
  test(`Update ${kind} is reported immediately while the active panel refreshes`, async (t) => {
    const reports: string[] = [];
    const f = fixture(true, true, {
      reportActionError: async (message) => {
        reports.push(message);
      },
    });

    t.onTestFinished(() => f.controller.dispose());
    const history: HistoryPage = {
      ...page([a]),
      refs: [
        {
          id: 'refs/heads/topic',
          name: 'topic',
          kind: 'local',
          sha: a,
          remote: null,
          tracking: {
            upstream: 'refs/remotes/origin/main',
            ahead: 1,
            behind: 105,
          },
        },
      ],
    };
    let refreshing!: () => void;
    const started = new Promise<void>((resolve) => {
      refreshing = resolve;
    });
    let finish!: (value: HistoryPage) => void;
    const pendingHistory = new Promise<HistoryPage>((resolve) => {
      finish = resolve;
    });
    let calls = 0;

    f.adapter.history = async () => {
      if (++calls > 1) {
        refreshing();

        return pendingHistory;
      }

      return history;
    };

    f.adapter.operate = async () => ({
      kind,
      backend: 'cli',
      message: 'Commit or stash local changes before updating.',
    });
    await f.controller.selectRepository('one');
    const pending = f.controller.handle(
      f.request({
        kind: 'action',
        action: { kind: 'update-branch', refId: 'refs/heads/topic' },
      }),
    );

    t.onTestFinished(async () => {
      finish(history);
      await pending;
    });
    await started;
    const immediateReports = [...reports];

    finish(history);
    await pending;
    expect(immediateReports).toStrictEqual([
      'Commit or stash local changes before updating.',
    ]);
    expect(reports).toStrictEqual(immediateReports);
    expect(
      f.sent.filter((message) => message.body.kind === 'operation').at(-1)
        ?.body,
    ).toStrictEqual({
      kind: 'operation',
      result: {
        kind,
        backend: 'cli',
        message: 'Commit or stash local changes before updating.',
      },
    });
    f.controller.dispose();
  });
}

for (const kind of ['conflict', 'error'] as const) {
  test(`A started Update ${kind} remains visible after switching repositories`, async (t) => {
    const reports: string[] = [];
    const f = fixture(true, true, {
      reportActionError: async (message) => {
        reports.push(message);
      },
    });

    t.onTestFinished(() => f.controller.dispose());
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (result: {
      kind: typeof kind;
      backend: 'api';
      message: string;
    }) => void;
    const result = new Promise<{
      kind: typeof kind;
      backend: 'api';
      message: string;
    }>((resolve) => {
      finish = resolve;
    });

    f.adapter.history = async () => ({
      ...page([a]),
      refs: [
        {
          id: 'refs/heads/main',
          name: 'main',
          kind: 'local',
          sha: a,
          remote: null,
          tracking: {
            upstream: 'refs/remotes/origin/main',
            ahead: 1,
            behind: 1,
          },
        },
      ],
    });
    f.adapter.operate = async () => {
      started();

      return result;
    };

    await f.controller.selectRepository('one');
    const pending = f.controller.handle(
      f.request({
        kind: 'action',
        action: { kind: 'update-branch', refId: 'refs/heads/main' },
      }),
    );

    t.onTestFinished(async () => {
      finish({ kind, backend: 'api', message: 'Fixture closed' });
      await pending;
    });
    await writing;
    await f.controller.selectRepository('two');
    finish({
      kind,
      backend: 'api',
      message: 'Update stopped; resolve through Source Control',
    });
    await pending;
    expect(reports).toStrictEqual([
      'Update stopped; resolve through Source Control',
    ]);
    f.controller.dispose();
  });
}

for (const change of ['repository', 'close'] as const) {
  test(`Update recovery remains visible when ${change} changes during its result refresh`, async (t) => {
    const reports: string[] = [];
    const f = fixture(true, true, {
      reportActionError: async (message) => {
        reports.push(message);
      },
    });

    t.onTestFinished(() => f.controller.dispose());
    let refreshing!: () => void;
    const started = new Promise<void>((resolve) => {
      refreshing = resolve;
    });
    let finish!: (value: HistoryPage) => void;
    const pendingHistory = new Promise<HistoryPage>((resolve) => {
      finish = resolve;
    });
    const history: HistoryPage = {
      ...page([a]),
      refs: [
        {
          id: 'refs/heads/main',
          name: 'main',
          kind: 'local',
          sha: a,
          remote: null,
          tracking: {
            upstream: 'refs/remotes/origin/main',
            ahead: 1,
            behind: 1,
          },
        },
      ],
    };
    let calls = 0;

    f.adapter.history = async (id) => {
      if (id === 'one' && ++calls > 1) {
        refreshing();

        return pendingHistory;
      }

      return history;
    };

    f.adapter.operate = async () => ({
      kind: 'conflict',
      backend: 'api',
      message: 'Resolve this Update in Source Control',
    });
    await f.controller.selectRepository('one');
    const pending = f.controller.handle(
      f.request({
        kind: 'action',
        action: { kind: 'update-branch', refId: 'refs/heads/main' },
      }),
    );

    t.onTestFinished(async () => {
      finish(history);
      await pending;
    });
    await started;
    if (change === 'close') f.controller.dispose();
    else await f.controller.selectRepository('two');
    finish(history);
    await pending;
    expect(reports).toStrictEqual(['Resolve this Update in Source Control']);
    expect(f.sent.filter((item) => item.body.kind === 'operation').length).toBe(
      0,
    );
    f.controller.dispose();
  });
}
