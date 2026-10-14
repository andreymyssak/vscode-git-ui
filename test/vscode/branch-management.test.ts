import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import type { GitAdapter } from '../../src/extension/git/adapter';
import { createGitAdapter } from '../../src/extension/git/adapter';
import { getGitApi } from '../../src/extension/git/api';
import { createSourceControlBackend } from '../../src/extension/git/source-control/index';
import { createFixture } from '../fixtures/repository';

describe('local branch management', () => {
  for (const invalidation of ['checkout', 'close', 'dispose'] as const)
    it(`rejects prepared branch creation after ${invalidation} without changing local edits or staging`, async () => {
      const fixture = await createFixture({
        prefix: 'git-ui-prepared-branch-',
      });
      const access = await getGitApi();

      await access.api.openRepository(vscode.Uri.file(fixture.root));
      const backend = await createSourceControlBackend();

      try {
        const branch = await backend.prepareBranchCreation(
          vscode.Uri.file(fixture.root).toString(),
        );

        await writeFile(join(fixture.root, 'sample.txt'), 'staged edit\n');
        await fixture.runGit(['add', 'sample.txt']);
        await writeFile(join(fixture.root, 'sample.txt'), 'working edit\n');
        const index = await fixture.runGit(['ls-files', '--stage', '-z']);

        if (invalidation === 'checkout') {
          await fixture.runGit(['branch', 'other']);
          await fixture.runGit(['switch', 'other']);
        } else if (invalidation === 'close')
          await vscode.commands.executeCommand(
            'git.close',
            vscode.Uri.file(fixture.root),
          );
        else backend.dispose();
        await assert.rejects(
          branch.write({ name: 'late-topic', beforeWrite() {} }),
          /changed|closed|disposed/i,
        );
        assert.equal(
          await fixture.runGit([
            'for-each-ref',
            '--format=%(refname)',
            'refs/heads/late-topic',
          ]),
          '',
        );
        assert.equal(
          await fixture.runGit(['ls-files', '--stage', '-z']),
          index,
        );
        assert.equal(
          await readFile(join(fixture.root, 'sample.txt'), 'utf8'),
          'working edit\n',
        );
      } finally {
        backend.dispose();
        if (
          access.api.repositories.some(
            (repo) => repo.rootUri.fsPath === fixture.root,
          )
        )
          await vscode.commands.executeCommand(
            'git.close',
            vscode.Uri.file(fixture.root),
          );
        await fixture.dispose();
      }
    });
  for (const kind of ['create-branch', 'create-branch-checkout'] as const)
    it(`${kind} starts at the selected branch and preserves its requested checkout behavior`, async () => {
      const fixture = await createFixture({
        prefix: 'git-ui-native-new-branch-',
      });
      let adapter: GitAdapter | undefined;

      try {
        const selected = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

        await fixture.runGit(['branch', 'source-tip']);
        await writeFile(join(fixture.root, 'sample.txt'), 'new main\n');
        await fixture.runGit(['add', '.']);
        await fixture.runGit(['commit', '-m', 'Advance main']);
        const original = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
        const access = await getGitApi();

        await access.api.openRepository(vscode.Uri.file(fixture.root));
        adapter = await createGitAdapter();
        const id = vscode.Uri.file(fixture.root).toString();
        const result = await adapter.operate(id, {
          kind,
          refId: 'refs/heads/source-tip',
          expectedSha: selected,
          name: 'native-new',
        });

        assert.equal(result.kind, 'success');
        assert.equal(
          (await fixture.runGit(['rev-parse', 'refs/heads/native-new'])).trim(),
          selected,
        );
        assert.equal(
          (await fixture.runGit(['branch', '--show-current'])).trim(),
          kind === 'create-branch' ? 'main' : 'native-new',
        );
        assert.equal(
          (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
          kind === 'create-branch' ? original : selected,
        );
        assert.equal(
          (
            await adapter.operate(id, {
              kind,
              refId: 'refs/heads/source-tip',
              expectedSha: original,
              name: 'stale',
            })
          ).kind,
          'error',
        );
        assert.equal(
          await fixture.runGit([
            'for-each-ref',
            '--format=%(refname)',
            'refs/heads/stale',
          ]),
          '',
        );
      } finally {
        adapter?.dispose();
        await vscode.commands.executeCommand(
          'git.close',
          vscode.Uri.file(fixture.root),
        );
        await fixture.dispose();
      }
    });

  it('keeps local edits, staging and checkout when creating and checking out a branch would overwrite them', async () => {
    const fixture = await createFixture({
      prefix: 'git-ui-native-checkout-dirty-',
    });
    let adapter: GitAdapter | undefined;

    try {
      const selected = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

      await fixture.runGit(['branch', 'source-tip']);
      await writeFile(join(fixture.root, 'sample.txt'), 'new main\n');
      await fixture.runGit(['add', '.']);
      await fixture.runGit(['commit', '-m', 'Advance main']);
      const head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

      await writeFile(join(fixture.root, 'sample.txt'), 'uncommitted edits\n');
      await writeFile(join(fixture.root, 'keep.txt'), 'staged work\n');
      await fixture.runGit(['add', 'keep.txt']);
      const index = await fixture.runGit(['ls-files', '--stage', '-z']);
      const access = await getGitApi();

      await access.api.openRepository(vscode.Uri.file(fixture.root));
      adapter = await createGitAdapter();
      const result = await adapter.operate(
        vscode.Uri.file(fixture.root).toString(),
        {
          kind: 'create-branch-checkout',
          refId: 'refs/heads/source-tip',
          expectedSha: selected,
          name: 'unsafe-topic',
        },
      );

      assert.equal(result.kind, 'error');
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
      assert.equal(
        (await fixture.runGit(['branch', '--show-current'])).trim(),
        'main',
      );
      assert.equal(await fixture.runGit(['ls-files', '--stage', '-z']), index);
      assert.equal(
        await readFile(join(fixture.root, 'sample.txt'), 'utf8'),
        'uncommitted edits\n',
      );
      assert.equal(
        await fixture.runGit([
          'for-each-ref',
          '--format=%(refname)',
          'refs/heads/unsafe-topic',
        ]),
        '',
      );
    } finally {
      adapter?.dispose();
      await vscode.commands.executeCommand(
        'git.close',
        vscode.Uri.file(fixture.root),
      );
      await fixture.dispose();
    }
  });

  it('renames the selected branch without switching or overwriting another branch', async () => {
    const fixture = await createFixture({
      prefix: 'git-ui-native branch rename ',
    });
    let adapter: GitAdapter | undefined;

    try {
      const access = await getGitApi();

      await access.api.openRepository(vscode.Uri.file(fixture.root));
      adapter = await createGitAdapter();
      const id = vscode.Uri.file(fixture.root).toString();
      const head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

      await fixture.runGit(['branch', 'topic']);
      const result = await adapter.operate(id, {
        kind: 'rename-branch',
        refId: 'refs/heads/topic',
        expectedSha: head,
        name: 'feature/renamed',
      });

      assert.equal(result.kind, 'success');
      assert.equal(result.backend, 'cli');
      assert.equal(
        (await fixture.runGit(['branch', '--show-current'])).trim(),
        'main',
      );
      assert.equal(
        (
          await fixture.runGit(['rev-parse', 'refs/heads/feature/renamed'])
        ).trim(),
        head,
      );
      assert.ok(
        !(
          await fixture.runGit([
            'for-each-ref',
            '--format=%(refname)',
            'refs/heads',
          ])
        )
          .split('\n')
          .includes('refs/heads/topic'),
      );
      assert.equal(
        (
          await adapter.operate(id, {
            kind: 'rename-branch',
            refId: 'refs/heads/feature/renamed',
            expectedSha: head,
            name: 'main',
          })
        ).kind,
        'error',
      );
      assert.equal(
        (
          await fixture.runGit(['rev-parse', 'refs/heads/feature/renamed'])
        ).trim(),
        head,
      );
      assert.equal(
        (
          await adapter.operate(id, {
            kind: 'rename-branch',
            refId: 'refs/heads/main',
            expectedSha: head,
            name: 'current-renamed',
          })
        ).kind,
        'success',
      );
      assert.equal(
        (await fixture.runGit(['branch', '--show-current'])).trim(),
        'current-renamed',
      );
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
      assert.equal(
        (
          await adapter.operate(id, {
            kind: 'rename-branch',
            refId: 'refs/heads/feature/renamed',
            expectedSha: 'a'.repeat(40),
            name: 'stale',
          })
        ).kind,
        'error',
      );
      await fixture.runGit(['tag', 'example']);
      assert.equal(
        (
          await adapter.operate(id, {
            kind: 'rename-branch',
            refId: 'refs/tags/example',
            expectedSha: head,
            name: 'tag-renamed',
          })
        ).kind,
        'error',
      );
    } finally {
      adapter?.dispose();
      await fixture.dispose();
    }
  });

  it('deletes merged branches but preserves current, unmerged and worktree branches', async () => {
    const fixture = await createFixture({
      prefix: 'git-ui-native branch delete ',
    });
    let adapter: GitAdapter | undefined;

    try {
      const access = await getGitApi();

      await access.api.openRepository(vscode.Uri.file(fixture.root));
      adapter = await createGitAdapter();
      const id = vscode.Uri.file(fixture.root).toString();
      const head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

      await fixture.runGit(['branch', 'merged']);
      const result = await adapter.operate(id, {
        kind: 'delete-branch',
        refId: 'refs/heads/merged',
        expectedSha: head,
      });

      assert.equal(result.kind, 'success');
      assert.equal(result.backend, 'api');
      assert.ok(
        !(
          await fixture.runGit([
            'for-each-ref',
            '--format=%(refname)',
            'refs/heads',
          ])
        )
          .split('\n')
          .includes('refs/heads/merged'),
      );
      assert.equal(
        (
          await adapter.operate(id, {
            kind: 'delete-branch',
            refId: 'refs/heads/main',
            expectedSha: head,
          })
        ).kind,
        'error',
      );
      const tree = (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
      const unmerged = (
        await fixture.runGit([
          'commit-tree',
          tree,
          '-p',
          head,
          '-m',
          'Unmerged',
        ])
      ).trim();

      await fixture.runGit(['update-ref', 'refs/heads/unmerged', unmerged]);
      assert.equal(
        (
          await adapter.operate(id, {
            kind: 'delete-branch',
            refId: 'refs/heads/unmerged',
            expectedSha: unmerged,
          })
        ).kind,
        'error',
      );
      assert.equal(
        (await fixture.runGit(['rev-parse', 'refs/heads/unmerged'])).trim(),
        unmerged,
      );
      await fixture.runGit([
        'worktree',
        'add',
        '-b',
        'linked',
        fixture.root + '/owned-linked',
      ]);
      assert.equal(
        (
          await adapter.operate(id, {
            kind: 'delete-branch',
            refId: 'refs/heads/linked',
            expectedSha: head,
          })
        ).kind,
        'error',
      );
      assert.equal(
        (await fixture.runGit(['rev-parse', 'refs/heads/linked'])).trim(),
        head,
      );
      assert.equal(
        (
          await adapter.operate(id, {
            kind: 'delete-branch',
            refId: 'refs/heads/linked',
            expectedSha: 'a'.repeat(40),
          })
        ).kind,
        'error',
      );
      await fixture.runGit(['update-ref', 'refs/heads/-n10', head]);
      const literal = await adapter.operate(id, {
        kind: 'delete-branch',
        refId: 'refs/heads/-n10',
        expectedSha: head,
      });

      assert.equal(literal.kind, 'success');
      assert.equal(literal.backend, 'cli');
      assert.equal(
        (await fixture.runGit(['branch', '--show-current'])).trim(),
        'main',
      );
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
    } finally {
      adapter?.dispose();
      await fixture.dispose();
    }
  });
});
