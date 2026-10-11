import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import * as vscode from 'vscode';

import type { GitAdapter } from '../../src/extension/git/adapter';
import { createGitAdapter } from '../../src/extension/git/adapter';
import { getGitApi } from '../../src/extension/git/api';
import type { Reference } from '../../src/shared/model';
import { disposeFixtureDirectory } from '../fixtures/repository';

const execute = promisify(execFile);

describe('incoming-only demo branches', () => {
  it('updates current, other and already-current branches without creating outgoing commits', async function () {
    this.timeout(90000);
    const created = await execute(
      process.execPath,
      [resolve(__dirname, '../../../scripts/dev/create-demo.ts')],
      {
        cwd: resolve(__dirname, '../../..'),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
    const demo = JSON.parse(created.stdout) as { root: string };
    const directory = dirname(demo.root);
    let adapter: GitAdapter | undefined;

    try {
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith('GIT_'),
          ),
        ),
        GIT_CONFIG_GLOBAL: resolve(directory, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      };
      const git = async (...args: string[]) =>
        (await execute('git', args, { cwd: demo.root, env })).stdout.trim();
      const id = vscode.Uri.file(demo.root).toString();
      const access = await getGitApi();

      await access.api.openRepository(vscode.Uri.file(demo.root));
      await access.repository(id).checkout('maintenance/behind-five');
      adapter = await createGitAdapter({
        remoteCheckout: async () => null,
        updateDiverged: async () => {
          throw new Error(
            'Incoming-only history must not ask for Merge/Rebase.',
          );
        },
      });

      const commits = await git('rev-list', '--count', '--all');
      const main = await git('rev-parse', 'main');
      const remoteMain = await git('rev-parse', 'origin/main');
      const remoteMerge = await git(
        'rev-parse',
        'origin/maintenance/behind-merge',
      );

      for (const [branch, behind] of [
        ['maintenance/behind-five', 5],
        ['maintenance/behind-one', 1],
        ['maintenance/behind-merge', 7],
        ['maintenance/up-to-date', 0],
      ] as const) {
        const refId = `refs/heads/${branch}`;
        const before: Reference | undefined = (
          await adapter.references(id)
        ).find((ref) => ref.id === refId);

        assert.ok(before?.tracking);
        assert.equal(before.tracking.ahead, 0);
        assert.equal(before.tracking.behind, behind);
        const upstream: string = before.tracking.upstream;
        const incomingTip = await git('rev-parse', upstream);
        const originalHead = await git('rev-parse', 'HEAD');
        const result = await adapter.operate(id, {
          kind: 'update-branch',
          refId,
          expectedSha: before.sha,
          expectedUpstream: upstream,
        });

        assert.equal(result.kind, 'success', JSON.stringify(result));
        assert.equal(await git('rev-parse', branch), incomingTip);
        assert.equal(
          await git('symbolic-ref', '--short', 'HEAD'),
          'maintenance/behind-five',
        );
        assert.equal(
          await git('rev-parse', 'HEAD'),
          branch === 'maintenance/behind-five' ? incomingTip : originalHead,
        );
        const after: Reference | undefined = (
          await adapter.references(id)
        ).find((ref) => ref.id === refId);

        assert.deepEqual(after?.tracking, { upstream, ahead: 0, behind: 0 });
        assert.equal(await git('rev-list', '--count', '--all'), commits);
        assert.equal(await git('rev-parse', 'main'), main);
        assert.equal(await git('status', '--porcelain'), '');
        assert.equal(await git('stash', 'list'), '');
      }

      assert.equal(
        await git(
          '--git-dir',
          resolve(directory, 'remote.git'),
          'rev-parse',
          'main',
        ),
        remoteMain,
      );
      assert.equal(
        await git(
          '--git-dir',
          resolve(directory, 'remote.git'),
          'rev-parse',
          'maintenance/behind-merge',
        ),
        remoteMerge,
      );
    } finally {
      adapter?.dispose();
      await disposeFixtureDirectory(directory);
    }
  });
});
