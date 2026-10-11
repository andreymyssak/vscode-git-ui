import * as vscode from 'vscode';

import type { GitCli } from '../git/cli';
import {
  readSelectedPatch,
  validateSelectedPatch,
} from '../git/selected-patch';
import type { WorkingFile } from '../git/working-changes';
import { draftCommitMessage } from './commit-message-model';

/** Called only by the host's explicit Generate Message action. */
export async function generateCommitMessage(
  cli: GitCli,
  id: string,
  files: readonly WorkingFile[],
  token: vscode.CancellationToken,
): Promise<string> {
  const abort = new AbortController();
  const subscription = token.onCancellationRequested(() => abort.abort());

  try {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const patch = await readSelectedPatch(cli, id, files, abort.signal);

    return await draftCommitMessage({
      patch,
      token,
      validate: () => validateSelectedPatch(cli, id, patch, abort.signal),
      provider: {
        models: async () =>
          (await vscode.lm.selectChatModels()).map((model) => ({
            id: model.id,
            name: model.name,
            vendor: model.vendor,
            maxInputTokens: model.maxInputTokens,
            countTokens: (prompt, cancellation) =>
              model.countTokens(
                vscode.LanguageModelChatMessage.User(prompt),
                cancellation,
              ),
            request: async (prompt, cancellation) =>
              (
                await model.sendRequest(
                  [vscode.LanguageModelChatMessage.User(prompt)],
                  {
                    justification:
                      'Draft a commit message for the files checked in Git UI.',
                  },
                  cancellation,
                )
              ).text,
          })),
        pick: async (models, cancellation) =>
          (
            await vscode.window.showQuickPick(
              models.map((model) => ({
                label: model.name,
                description: `${model.vendor} · ${model.id}`,
                model,
              })),
              {
                title: 'Generate Commit Message',
                placeHolder: 'Choose a language model',
              },
              cancellation,
            )
          )?.model,
      },
    });
  } catch (error) {
    if (
      token.isCancellationRequested ||
      (error instanceof Error && error.name === 'Canceled')
    )
      throw new vscode.CancellationError();
    throw error;
  } finally {
    subscription.dispose();
  }
}
