import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import type { GitAdapter } from '../../src/extension/git/adapter';
import { createGitAdapter } from '../../src/extension/git/adapter';
import { getGitApi } from '../../src/extension/git/api';
import { createFixture } from '../fixtures/repository';

describe('tracked branch Update', () => {
  // This covers multiple real fetch/update operations and their safety checks.
  // Allow Windows Git process startup without extending individual UI waits.
  it('reads every local upstream count and fast-forwards without pushing, creating a merge commit or stashing', async () => {
    const fixture = await createFixture({ prefix: 'git-ui-native-update-' });
    let adapter: GitAdapter | undefined;
    const remote = fixture.root + '-remote.git';

    try {
      const id = vscode.Uri.file(fixture.root).toString();

      await fixture.runGit(['init', '--bare', remote]);
      await fixture.runGit(['remote', 'add', 'origin', remote]);
      await fixture.runGit([
        '--git-dir',
        remote,
        'fetch',
        fixture.root,
        'main:refs/heads/main',
      ]);
      const base = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const tree = (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
      const incoming = (
        await fixture.runGit([
          'commit-tree',
          tree,
          '-p',
          base,
          '-m',
          'Incoming',
        ])
      ).trim();

      await fixture.runGit([
        '--git-dir',
        remote,
        'fetch',
        fixture.root,
        `${incoming}:refs/heads/main`,
      ]);
      await fixture.runGit(['fetch', 'origin']);
      await fixture.runGit(['branch', '--set-upstream-to=origin/main', 'main']);
      await fixture.runGit(['branch', 'topic', base]);
      await fixture.runGit([
        'branch',
        '--set-upstream-to=origin/main',
        'topic',
      ]);
      await fixture.runGit(['config', 'pull.rebase', 'true']);
      const access = await getGitApi();

      await access.api.openRepository(vscode.Uri.file(fixture.root));
      await access.repository(id).status();
      adapter = await createGitAdapter({
        remoteCheckout: async () => null,
        updateDiverged: async () => null,
      });

      const refs = await adapter.references(id);

      assert.deepEqual(
        refs.find((ref) => ref.id === 'refs/heads/main')?.tracking,
        { upstream: 'refs/remotes/origin/main', ahead: 0, behind: 1 },
      );
      assert.equal(
        refs.find((ref) => ref.id === 'refs/heads/topic')?.tracking?.behind,
        1,
      );
      await writeFile(join(fixture.root, 'dirty.txt'), 'local change');
      await fixture.runGit(['config', 'status.showUntrackedFiles', 'no']);
      const result = await adapter.operate(id, {
        kind: 'update-branch',
        refId: 'refs/heads/main',
        expectedSha: base,
        expectedUpstream: 'refs/remotes/origin/main',
      });

      assert.equal(result.kind, 'error');
      assert.equal(
        result.kind === 'error' ? result.recovery : null,
        'source-control',
      );
      assert.equal(
        result.kind === 'error' ? result.message : '',
        'Commit or stash local changes before updating.',
      );
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), base);
      await writeFile(join(fixture.root, 'sample.txt'), 'staged edit\n');
      await fixture.runGit(['add', 'sample.txt']);
      await writeFile(join(fixture.root, 'sample.txt'), 'unstaged edit\n');
      const index = await fixture.runGit(['diff', '--cached', '--binary']);
      const worktree = await fixture.runGit(['diff', '--binary']);
      const status = await fixture.runGit([
        'status',
        '--porcelain',
        '--untracked-files=all',
      ]);
      const otherWithEdits = await adapter.operate(id, {
        kind: 'update-branch',
        refId: 'refs/heads/topic',
        expectedSha: base,
        expectedUpstream: 'refs/remotes/origin/main',
      });

      assert.equal(
        otherWithEdits.kind,
        'success',
        JSON.stringify(otherWithEdits),
      );
      assert.equal(
        (await fixture.runGit(['rev-parse', 'topic'])).trim(),
        incoming,
      );
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), base);
      assert.equal(
        (await fixture.runGit(['symbolic-ref', '--short', 'HEAD'])).trim(),
        'main',
      );
      assert.equal(
        await fixture.runGit(['diff', '--cached', '--binary']),
        index,
      );
      assert.equal(await fixture.runGit(['diff', '--binary']), worktree);
      assert.equal(
        await fixture.runGit([
          'status',
          '--porcelain',
          '--untracked-files=all',
        ]),
        status,
      );
      assert.equal(
        await readFile(join(fixture.root, 'dirty.txt'), 'utf8'),
        'local change',
      );
      assert.equal((await fixture.runGit(['stash', 'list'])).trim(), '');
      await fixture.runGit(['restore', '--staged', '--worktree', 'sample.txt']);
      await rm(join(fixture.root, 'dirty.txt'));
      await fixture.runGit([
        'symbolic-ref',
        'refs/heads/alias',
        'refs/heads/main',
      ]);
      await fixture.runGit(['config', 'branch.alias.remote', 'origin']);
      await fixture.runGit(['config', 'branch.alias.merge', 'refs/heads/main']);
      assert.ok(
        (await adapter.references(id)).some(
          (ref) => ref.id === 'refs/heads/alias',
        ),
      );
      const aliasUpdate = await adapter.operate(id, {
        kind: 'update-branch',
        refId: 'refs/heads/alias',
        expectedSha: base,
        expectedUpstream: 'refs/remotes/origin/main',
      });

      assert.equal(aliasUpdate.kind, 'error');
      assert.match(
        aliasUpdate.kind === 'error' ? aliasUpdate.message : '',
        /symbolic/,
      );
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), base);
      const updated = await adapter.operate(id, {
        kind: 'update-branch',
        refId: 'refs/heads/main',
        expectedSha: base,
        expectedUpstream: 'refs/remotes/origin/main',
      });

      assert.equal(updated.kind, 'success', JSON.stringify(updated));
      assert.equal(
        (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
        incoming,
      );
      assert.equal(
        (await fixture.runGit(['rev-parse', 'topic'])).trim(),
        incoming,
      );
      assert.equal(
        (
          await fixture.runGit(['--git-dir', remote, 'rev-parse', 'main'])
        ).trim(),
        incoming,
      );
      const otherUpdated = await adapter.operate(id, {
        kind: 'update-branch',
        refId: 'refs/heads/topic',
        expectedSha: incoming,
        expectedUpstream: 'refs/remotes/origin/main',
      });

      assert.equal(otherUpdated.kind, 'success', JSON.stringify(otherUpdated));
      assert.equal(
        (await fixture.runGit(['rev-parse', 'topic'])).trim(),
        incoming,
      );
      assert.equal(
        (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
        incoming,
      );
      assert.equal(
        (await fixture.runGit(['symbolic-ref', '--short', 'HEAD'])).trim(),
        'main',
      );
      const local = (
        await fixture.runGit([
          'commit-tree',
          tree,
          '-p',
          incoming,
          '-m',
          'Local divergence',
        ])
      ).trim();
      const nextRemote = (
        await fixture.runGit([
          'commit-tree',
          tree,
          '-p',
          incoming,
          '-m',
          'Remote divergence',
        ])
      ).trim();

      await fixture.runGit(['update-ref', 'refs/heads/main', local]);
      await fixture.runGit([
        '--git-dir',
        remote,
        'fetch',
        fixture.root,
        `${nextRemote}:refs/heads/main`,
      ]);
      assert.equal(
        (
          await adapter.operate(id, {
            kind: 'update-branch',
            refId: 'refs/heads/main',
            expectedSha: local,
            expectedUpstream: 'refs/remotes/origin/main',
          })
        ).kind,
        'cancelled',
      );
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), local);
      assert.equal((await fixture.runGit(['stash', 'list'])).trim(), '');
    } finally {
      adapter?.dispose();
      await fixture.dispose();
      await rm(remote, { recursive: true, force: true });
    }
  }).timeout(90000);
});
