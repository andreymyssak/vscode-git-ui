import * as vscode from 'vscode';

import type { WorkingFile } from '../../../shared/source-control';
import type { BeforeWrite, RepositoryLease } from './repository';
import {
  captureRollback,
  rollbackSelected,
  validateNewFiles,
} from './rollback';

export async function prepareRollback(
  lease: RepositoryLease,
  { id, files }: { id: string; files: readonly WorkingFile[] },
) {
  const plan = await captureRollback(
    lease.cli,
    id,
    files.map((file) => ({ ...file })),
  );

  lease.current();

  return {
    hasNewFiles: plan.newFiles.some((file) => file.identity !== null),
    write({
      deleteNewFiles,
      useTrash,
      beforeWrite,
    }: {
      deleteNewFiles: boolean;
      useTrash: boolean;
      beforeWrite: BeforeWrite;
    }) {
      const requireCurrent = () => {
        lease.current();
        beforeWrite();
      };

      return lease.write(beforeWrite, async (cli) => {
        await rollbackSelected(cli, id, plan, requireCurrent);
        if (!deleteNewFiles) return;
        requireCurrent();
        await validateNewFiles(plan);
        for (const file of plan.newFiles) {
          if (file.identity === null) continue;
          requireCurrent();
          await validateNewFiles({ ...plan, newFiles: [file] });
          requireCurrent();
          await vscode.workspace.fs.delete(
            vscode.Uri.joinPath(lease.root, ...file.path.split('/')),
            { useTrash },
          );
        }
      });
    },
  };
}
