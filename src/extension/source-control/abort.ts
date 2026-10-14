import * as vscode from 'vscode';

import { operationPresentation } from '../../shared/source-control-operation';
import type { SourceControlBackend } from '../git/source-control/index';
import type { SourceControlModel } from './model';
import { requireLiveRepository } from './writes';

export async function abortOperation({
  runtime,
  model,
  id,
  token,
}: {
  runtime: SourceControlBackend;
  model: SourceControlModel;
  id: string;
  token: string;
}) {
  const beforeWrite = () => requireLiveRepository(runtime, model, id);

  beforeWrite();
  const prepared = await runtime.prepareAbort(id, token);
  const presentation = operationPresentation(prepared.operation.kind);
  const choice = await vscode.window.showWarningMessage(
    `${presentation.label.replace('…', '')}?`,
    {
      modal: true,
      detail: `${presentation.tooltip}${prepared.operation.paths.length ? `\n\nAffected files:\n${prepared.operation.paths.join('\n')}` : ''}`,
    },
    presentation.label.replace('…', ''),
  );

  if (choice !== presentation.label.replace('…', '')) return;
  await prepared.write({
    beforeWrite,
    protectionPaths: () =>
      vscode.workspace.textDocuments
        .filter(
          (document) => document.isDirty && document.uri.scheme === 'file',
        )
        .map((document) => document.uri.fsPath),
  });
}
