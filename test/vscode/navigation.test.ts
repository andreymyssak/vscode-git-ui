import assert from 'node:assert/strict';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { createGitAdapter } from '../../src/extension/git/adapter';
import { getGitApi } from '../../src/extension/git/api';
import { PanelController } from '../../src/extension/panel/controller';
import type { PanelBody, RequestBody, Result } from '../../src/shared/messages';
import { commitLinearHistory, createFixture } from '../fixtures/repository';

describe('native navigation', () => {
  it('reveals distant targets and preserves scope when a scope change is declined', async () => {
    const fixture = await createFixture({
      prefix: 'git-ui-native navigation ',
    });
    let controller: PanelController | null = null;

    try {
      const original = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const tree = (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
      const head = await commitLinearHistory(
        fixture,
        original,
        Array.from({ length: 205 }, (_, i) => ({
          message: `Nav ${i}`,
          date: `${1700000000 + i} +0000`,
        })),
      );

      await fixture.runGit(['update-ref', 'refs/heads/main', head]);
      await fixture.runGit(['tag', 'main', original]);
      const outside = (
        await fixture.runGit(['commit-tree', tree, '-m', 'Unreachable'])
      ).trim();

      await (
        await getGitApi()
      ).api.openRepository(vscode.Uri.file(fixture.root));
      await (
        await getGitApi()
      )
        .repository(vscode.Uri.file(fixture.root).toString())
        .status();
      await expect
        .poll(() =>
          getGitApi().then(
            (access) =>
              access.repository(vscode.Uri.file(fixture.root).toString()).state
                .HEAD?.commit,
          ),
        )
        .toBe(head);
      const adapter = await createGitAdapter();
      const id = vscode.Uri.file(fixture.root).toString();
      const sent: Result<PanelBody>[] = [];
      let accept = false;
      let picks = 0;

      controller = new PanelController({
        adapter,
        trusted: () => true,
        send: (m) => {
          sent.push(m);
        },
        openChange: async () => {},
        pickRepository: async () => null,
        initialRepositoryId: id,
        pickReference: async (refs) => {
          picks++;

          return refs.find((r) => r.kind === 'tag')?.id ?? null;
        },
        offerNavigation: async () => accept,
      });
      await controller.selectRepository(id);
      const request = async (body: RequestBody) => {
        const generation = Math.max(
          1,
          ...sent.map((message) => message.generation),
        );

        await controller!.handle({
          requestId: 'nav',
          repositoryId: id,
          generation,
          body,
        });
      };

      await request({ kind: 'go-to', input: original });
      assert.ok(
        sent.some((m) => m.body.kind === 'reveal' && m.body.sha === original),
      );
      await request({
        kind: 'history',
        scope: { kind: 'head' },
        text: 'absent',
        cursor: null,
      });
      const before = sent.filter((m) => m.body.kind === 'history').at(-1);

      await request({ kind: 'go-to', input: 'main' });
      assert.equal(picks, 1);
      assert.deepEqual(
        sent.filter((m) => m.body.kind === 'history').at(-1),
        before,
      );
      accept = true;
      await request({ kind: 'go-to', input: original });
      const clear = sent.filter((m) => m.body.kind === 'history').at(-1)?.body;

      assert.ok(clear?.kind === 'history');
      assert.deepEqual(clear.scope, { kind: 'all' });
      assert.equal(clear.text, '');
      await request({ kind: 'go-to', input: outside });
      const special = sent
        .filter((m) => m.body.kind === 'history')
        .at(-1)?.body;

      assert.ok(special?.kind === 'history');
      assert.deepEqual(special.scope, { kind: 'commit', sha: outside });
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
    } finally {
      controller?.dispose();
      await fixture.dispose();
    }
  });
});
