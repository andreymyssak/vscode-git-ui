import * as vscode from 'vscode';

import type { SourceControlBackend } from '../git/source-control/index';
import { showOperationError } from '../native/operation-feedback';
import {
  clearSourceControlBusy,
  publishSourceControlContexts,
} from './context';
import type { SourceControlModel } from './model';
import type { SourceControlReadProgress } from './read-progress';
import { errorMessage } from './state';
import { requireLiveRepository } from './writes';

/** Native command completion releases editing; status refresh owns separate activity. */
export async function runSourceControlWrite({
  id,
  title,
  action,
  model,
  reads,
  beforeWrite,
  initialize,
  closed,
  publish,
  refresh,
}: {
  id: string;
  title: string;
  action: (runtime: SourceControlBackend) => Promise<void>;
  model: SourceControlModel;
  reads: SourceControlReadProgress;
  beforeWrite(this: void): void;
  initialize(this: void): Promise<SourceControlBackend>;
  closed(this: void): boolean;
  publish(this: void): void;
  refresh(this: void): Promise<void>;
}): Promise<void> {
  if (model.busy) return;
  model.busy = true;
  reads.cancel();
  model.activity = { repositoryId: id, title };
  beforeWrite();
  model.error = null;
  publish();
  let runtime: SourceControlBackend | null = null;

  try {
    await publishSourceControlContexts(model);
    runtime = await initialize();
    if (closed()) return;
    requireLiveRepository(runtime, model, id);
    const current = runtime;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title },
      () => action(current),
    );
  } finally {
    // Native menus must be enabled before the webview exposes editable rows.
    await clearSourceControlBusy();
    model.busy = false;
    model.activity = null;
    if (!closed() && runtime) {
      const current = reads.start(id);
      const backend = runtime;

      void (async () => {
        try {
          await backend.status(id);
        } catch {
          /* A repository can close during its command. */
        }

        if (closed() || !current()) return;
        await refresh();
      })().catch((error: unknown) => {
        if (closed() || !current()) return;
        model.error = errorMessage(error);
        reads.finish();
        publish();
        void showOperationError(model.error, true);
      });
    }

    publish();
  }
}
