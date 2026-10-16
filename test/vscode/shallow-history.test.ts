import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import * as vscode from 'vscode';

import { createGitAdapter } from '../../src/extension/git/adapter';
import { getGitApi } from '../../src/extension/git/api';
import { commitLinearHistory, createFixture } from '../fixtures/repository';

describe('shallow history invalidation', () => {
  it('observes shared shallow metadata when an unshallow fetch leaves branch tips unchanged', async () => {
    const origin = await createFixture({ prefix: 'git-ui-shallow-native-' });
    const clone = join(origin.root, 'clone');
    let adapter: Awaited<ReturnType<typeof createGitAdapter>> | undefined;
    let subscription: vscode.Disposable | undefined;

    try {
      const initial = (await origin.runGit(['rev-parse', 'HEAD'])).trim();
      const head = await commitLinearHistory(origin, initial, [
        { message: 'Second', date: '1700000000 +0000' },
        { message: 'Third', date: '1700000001 +0000' },
        { message: 'Fourth', date: '1700000002 +0000' },
      ]);

      await origin.runGit(['update-ref', 'refs/heads/main', head]);
      await origin.runGit([
        'clone',
        '--depth=1',
        '--single-branch',
        '--no-tags',
        pathToFileURL(origin.root).href,
        clone,
      ]);
      const access = await getGitApi();

      assert.ok(await access.api.openRepository(vscode.Uri.file(clone)));
      const id = vscode.Uri.file(clone).toString();

      await access.repository(id).status();
      adapter = await createGitAdapter();
      let changes = 0;

      subscription = adapter.subscribe(id, () => {
        changes++;
      });
      const query = {
        scope: { kind: 'head' as const },
        text: '',
        cursor: null,
      };
      const before = await adapter.history(id, query);

      assert.equal(before.commits.length, 1);
      assert.equal(before.nextCursor, null);
      await access.repository(id).status();
      await adapter.history(id, query);
      changes = 0;
      await origin.runGit(['-C', clone, 'fetch', '--unshallow', 'origin']);
      assert.equal(
        (await origin.runGit(['-C', clone, 'rev-parse', 'HEAD'])).trim(),
        head,
      );
      const deadline = Date.now() + 10000;

      while (!changes && Date.now() < deadline) await delay(25);
      assert.ok(
        changes > 0,
        'The shallow file change must invalidate observed history without a manual refresh.',
      );
      const after = await adapter.history(id, query);

      assert.equal(after.commits.length, 4);
      assert.notEqual(after.scopeId, before.scopeId);
    } finally {
      subscription?.dispose();
      adapter?.dispose();
      await origin.dispose();
    }
  });
});
