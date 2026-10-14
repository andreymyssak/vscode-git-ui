import { assert, expect, onTestFinished, test, vi } from 'vitest';

import { PanelActions } from '../../src/extension/panel/actions';
import { commitMenuRequest } from '../../src/extension/panel/protocol';
import { QuerySession } from '../../src/extension/panel/queries';
import { a, b, fixture } from '../fixtures/controller';

const sha = 'a'.repeat(40);
const parent = 'b'.repeat(40);
const head = 'c'.repeat(40);
const file = {
  id: 'file-one',
  status: 'modified' as const,
  oldPath: 'one.ts',
  newPath: 'one.ts',
};
const menu = {
  repositoryId: 'repo',
  generation: 1,
  commitSha: sha,
  fileId: file.id,
  fileIds: [file.id],
  fileSelectionCount: 1,
};

test.each(['cherry-pick-files', 'revert-files'] as const)(
  '%s resolves only file handles owned by the active comparison',
  async (kind) => {
    const session = new QuerySession();
    const f = fixture();

    onTestFinished(() => {
      session.dispose();
      f.controller.dispose();
    });
    session.begin('repo', 1);
    session.repositoryInfo = {
      id: 'repo',
      label: 'Repo',
      rootUri: 'file:///repo',
      branch: 'main',
      headSha: head,
    };
    session.commits.set(sha, {
      sha,
      parents: [parent],
      message: 'Source',
      authorName: null,
      authorEmail: null,
      authorDate: null,
      commitDate: null,
    });
    session.selectRange([sha, parent], sha);
    session.files.set(file.id, { sha, parentSha: parent, file });
    const request = commitMenuRequest(kind, menu);

    assert.ok(request?.body.kind === 'action');
    const actions = new PanelActions(f.adapter, session, {});
    const result = await actions.review(request.body.action, request);

    expect(result.action).toEqual({
      kind,
      sha,
      parentSha: parent,
      files: [file],
      expectedHeadSha: head,
      expectedBranch: 'main',
    });
    session.selectRange([sha, parent], parent);
    expect(result.context?.aborted).toBe(true);
  },
);

test.each([
  { fileIds: [], fileSelectionCount: 0 },
  { fileIds: [file.id, file.id], fileSelectionCount: 2 },
  { fileIds: [file.id], fileSelectionCount: 2 },
  { fileId: 'outside' },
])('selected file menus reject invalid counts and anchors, %j', (change) => {
  expect(
    commitMenuRequest('cherry-pick-files', { ...menu, ...change }),
  ).toBeNull();
});

test('selected changes reject obsolete file handles without writing', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  await f.controller.handle(
    f.request({ kind: 'ready', savedRepositoryId: null }, '', 0),
  );
  await f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'cherry-pick-files', fileIds: ['outside'] },
    }),
  );
  expect(f.writes).toEqual([]);
  expect(f.sent.some((message) => message.body.kind === 'error')).toBe(true);
});

for (const kind of ['cherry-pick-files', 'revert-files'] as const)
  test.each(['background refresh', 'user selection'] as const)(
    `${kind} defers only background refresh, %s`,
    async (boundary) => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const f = fixture();

      onTestFinished(() => f.controller.dispose());
      await f.controller.selectRepository('one');
      await f.controller.handle(f.request({ kind: 'select-commit', sha: a }));
      let started!: () => void;
      let finish!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const write = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let signal: AbortSignal | undefined;

      f.adapter.operate = async (_id, _action, context) => {
        signal = context;
        started();
        await write;

        return { kind: 'success', backend: 'api' };
      };

      const pending = f.controller.handle(
        f.request({
          kind: 'action',
          action: { kind, fileIds: [`one-${a}`] },
        }),
      );

      onTestFinished(async () => {
        finish();
        await pending;
      });
      await ready;
      if (boundary === 'background refresh') f.fireHistoryEvent();
      else
        await f.controller.handle(f.request({ kind: 'select-commit', sha: b }));
      await vi.advanceTimersByTimeAsync(100);
      const aborted = signal?.aborted;

      finish();
      await pending;
      expect(aborted).toBe(boundary === 'user selection');
    },
  );
