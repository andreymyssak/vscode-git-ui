import * as vscode from 'vscode';

import type { SourceControlModel } from './model';
import { requireLiveRepository, type SourceControlRuntime } from './writes';

export async function toggleAmend(
  runtime: SourceControlRuntime,
  model: SourceControlModel,
  id: string,
  enabled: boolean,
): Promise<void> {
  requireLiveRepository(runtime, model, id);
  if (!enabled) {
    model.setAmend(id, null);

    return;
  }

  const commit = await runtime.access.repository(id).getCommit('HEAD');
  const message = commit.message.trimEnd();

  requireLiveRepository(runtime, model, id);
  if (message.length > 65536)
    throw new Error(
      'The last commit message is too long for the commit editor.',
    );
  model.setAmend(id, {
    headSha: commit.hash,
    message,
  });
}

export async function chooseMessage(
  model: SourceControlModel,
  id: string,
): Promise<void> {
  const draft = model.draft(id);
  const choice = await vscode.window.showQuickPick(
    model.messageHistory(id).map((message) => ({
      label: message.trimStart().split('\n')[0] ?? message,
      ...(message.includes('\n') ? { detail: message } : {}),
      message,
    })),
    {
      title: 'Commit Message History',
      placeHolder: 'Choose a previous commit message',
      matchOnDetail: true,
    },
  );

  model.requireRepository(id);
  if (choice && model.draft(id) === draft) model.setDraft(id, choice.message);
}
