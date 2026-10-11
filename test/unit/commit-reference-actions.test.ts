import { tmpdir } from 'node:os';

import { assert, expect, test } from 'vitest';

import type { GitAdapter } from '../../src/extension/git/adapter';
import type { GitApiAccess } from '../../src/extension/git/api';
import { createOperations } from '../../src/extension/git/operations';
import { PanelActions } from '../../src/extension/panel/actions';
import { commitMenuRequest } from '../../src/extension/panel/protocol';
import { QuerySession } from '../../src/extension/panel/queries';

const sha = 'a'.repeat(40);

for (const kind of ['branch-from-commit', 'tag-from-commit'] as const) {
  test(`${kind} uses a loaded single commit and cancels a changed prompt context`, async (t) => {
    const session = new QuerySession();

    t.onTestFinished(() => session.dispose());
    session.begin('repo', 1);
    session.select(sha);
    session.commits.set(sha, {
      sha,
      message: 'Commit',
      parents: [],
      authorDate: null,
      commitDate: null,
      authorName: null,
      authorEmail: null,
    });
    const context = {
      repositoryId: 'repo',
      generation: 1,
      commitSha: sha,
      commitShas: [sha],
      commitSelectionCount: 1,
    };
    const request = commitMenuRequest(kind, context);

    assert.ok(request);
    const actions = new PanelActions({} as GitAdapter, session, {
      askBranchName: async () => 'new-name',
      askTagName: async () => 'new-name',
    });

    expect(await actions.prepare({ kind, sha }, request)).toStrictEqual({
      kind,
      sha,
      name: 'new-name',
    });
    const changed = new PanelActions({} as GitAdapter, session, {
      askBranchName: async () => {
        session.begin('other');

        return 'name';
      },
      askTagName: async () => {
        session.begin('other');

        return 'name';
      },
    });

    await expect(changed.prepare({ kind, sha }, request)).rejects.toThrow(
      /changed/,
    );
    expect(
      commitMenuRequest(kind, {
        ...context,
        commitShas: [sha, 'b'.repeat(40)],
        commitSelectionCount: 2,
      }),
    ).toBe(null);
  });
  test(`${kind} pins the native API to the commit without checkout or force`, async () => {
    const writes: unknown[][] = [];
    const access = {
      repository: () => ({
        getCommit: async () => ({ hash: sha }),
        createBranch: async (...args: unknown[]) => {
          writes.push(args);
        },
        tag: async (...args: unknown[]) => {
          writes.push(args);
        },
        status: async () => {},
      }),
    } as unknown as GitApiAccess;
    const operate = createOperations(
      access,
      {
        run: async (_id, args) =>
          args.includes('--git-common-dir') ? tmpdir() : '',
      },
      { updateDiverged: async () => null, remoteCheckout: async () => null },
    );

    expect(
      (await operate('repo', { kind, sha, name: 'release/example' })).kind,
    ).toBe('success');
    expect(writes).toStrictEqual([
      kind === 'branch-from-commit'
        ? ['release/example', false, sha]
        : ['release/example', '', sha],
    ]);
    writes.length = 0;
    expect(
      (await operate('repo', { kind, sha: '--bad', name: 'name' })).kind,
    ).toBe('error');
    expect(writes).toStrictEqual([]);
  });
}
