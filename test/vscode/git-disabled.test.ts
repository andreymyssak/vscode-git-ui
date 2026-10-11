import assert from 'node:assert/strict';

import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { PanelController } from '../../src/extension/panel/controller';
import { commandId, EXTENSION_ID } from '../../src/shared/extension-identity';
import type { PanelBody } from '../../src/shared/messages';

describe('native setup', () => {
  it('disabled Git produces actionable setup rather than empty history', async () => {
    const configuration = vscode.workspace.getConfiguration('git');
    const original = configuration.inspect<boolean>('enabled')?.globalValue;

    let controller: PanelController | undefined;

    try {
      await configuration.update(
        'enabled',
        false,
        vscode.ConfigurationTarget.Global,
      );
      await expect
        .poll(async () => {
          try {
            await getGitApi();

            return false;
          } catch (error) {
            return error instanceof Error && /Enable/.test(error.message);
          }
        })
        .toBe(true);
      await assert.rejects(() => getGitApi(), /Enable/);
      await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
      for (const command of [
        'annotate-blame',
        'close-blame',
        'open-blame-commit',
      ] as const)
        assert.equal(
          await vscode.commands.executeCommand(commandId(command)),
          false,
        );
      const messages: PanelBody[] = [];

      controller = new PanelController({
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

      await controller.handle({
        requestId: 'setup',
        repositoryId: '',
        generation: 0,
        body: { kind: 'ready', savedRepositoryId: null },
      });
      assert.ok(
        messages.some(
          (message) =>
            message.kind === 'setup' && message.state === 'git-disabled',
        ),
      );
    } finally {
      controller?.dispose();
      await configuration.update(
        'enabled',
        original,
        vscode.ConfigurationTarget.Global,
      );
      await expect
        .poll(async () => {
          try {
            await getGitApi();

            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
    }
  });
});
