import * as vscode from 'vscode';

import type { BeforeWrite, RepositoryLease } from './repository';
import { readWorkingChanges } from './working-changes';

export async function prepareDiscard(
  lease: RepositoryLease,
  { id, path }: { id: string; path: string },
) {
  const current = (await readWorkingChanges(lease.cli, id)).find(
    (file) => file.path === path,
  );

  if (!current?.working || /U|AA|DD/.test(current.status))
    throw new Error(
      'This file has no discardable working changes. Refresh and review it again.',
    );
  lease.current();

  return {
    file: { ...current },
    write({ beforeWrite }: { beforeWrite: BeforeWrite }) {
      return lease.write(beforeWrite, async (cli, repository) => {
        const fresh = (await readWorkingChanges(cli, id)).find(
          (file) => file.path === path,
        );

        if (!fresh || JSON.stringify(fresh) !== JSON.stringify(current))
          throw new Error(
            'This file changed while confirming. Refresh and review it again.',
          );
        beforeWrite();
        await repository.status();
        lease.current();
        beforeWrite();
        await repository.clean([
          vscode.Uri.joinPath(lease.root, ...path.split('/')).fsPath,
        ]);
      });
    },
  };
}
