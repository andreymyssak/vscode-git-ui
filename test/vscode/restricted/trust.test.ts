import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { getGitApi } from '../../../src/extension/git/api';
import { registerBlame } from '../../../src/extension/native/blame-commands';
import { PanelController } from '../../../src/extension/panel/controller';
import { commandId } from '../../../src/shared/extension-identity';
import type { PanelBody } from '../../../src/shared/messages';

describe('restricted workspace', () => {
  it('untrusted native workspace blocks Git access and shows setup', async () => {
    assert.equal(vscode.workspace.isTrusted, false);
    await assert.rejects(() => getGitApi(), /Trust this workspace/);
    const subscriptions: vscode.Disposable[] = [];

    // VS Code disables our vscode.git dependency before extension activation.
    // Register the actual handlers to verify their independent trust guards.
    registerBlame(
      { subscriptions },
      {
        revealCommit: async () => {
          throw new Error('Must not navigate');
        },
      },
    );
    try {
      for (const command of [
        'annotate-blame',
        'close-blame',
        'open-blame-commit',
        'open-current-blame-commit',
      ] as const)
        assert.equal(
          await vscode.commands.executeCommand(commandId(command)),
          false,
        );
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
    }

    const messages: PanelBody[] = [];
    const controller = new PanelController({
      adapter: null,
      trusted: () => vscode.workspace.isTrusted,
      send: (message) => {
        messages.push(message.body);
      },
      openChange: async () => {
        throw new Error('Must not open');
      },
      pickRepository: async () => null,
      initialRepositoryId: null,
    });

    try {
      await controller.handle({
        requestId: 'trust',
        repositoryId: '',
        generation: 0,
        body: { kind: 'ready', savedRepositoryId: null },
      });
      assert.ok(
        messages.some(
          (message) =>
            message.kind === 'setup' && message.state === 'untrusted',
        ),
      );
    } finally {
      controller.dispose();
    }
  });
});
