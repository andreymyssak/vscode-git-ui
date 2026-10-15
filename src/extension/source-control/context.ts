import * as vscode from 'vscode';

import type { SourceControlModel } from './model';

export async function clearSourceControlBusy(): Promise<void> {
  await Promise.resolve(
    vscode.commands.executeCommand(
      'setContext',
      'gitUI.sourceControlBusy',
      false,
    ),
  ).catch(() => undefined);
}

export async function publishSourceControlContexts(
  model: SourceControlModel,
): Promise<void> {
  const checked = model.repositoryId
    ? (model.repositories.get(model.repositoryId)?.checked.selected().length ??
      0)
    : 0;

  // Keep native repository title actions independent of the busy key. VS Code
  // debounces menu rebuilds, which can restore toolbar focus after a picker opens.
  // The host's model.busy guard still rejects competing actions.
  await Promise.all(
    [
      ['gitUI.changesHasChecked', checked > 0],
      ['gitUI.sourceControlBusy', model.busy],
      ['gitUI.changesHasRepository', model.repositoryId !== null],
    ].map(([key, value]) =>
      Promise.resolve(
        vscode.commands.executeCommand('setContext', key, value),
      ).catch(() => undefined),
    ),
  );
}
