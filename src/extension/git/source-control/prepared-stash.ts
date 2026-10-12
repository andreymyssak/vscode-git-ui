import type { StashFile } from '../../../shared/source-control';
import { deleteStashFiles, renameStash } from './edit-stash';
import type { BeforeWrite, RepositoryLease } from './repository';
import { applyStash, deleteStash, restoreStashFiles } from './stash-operations';
import { requireStashIdentity } from './stashes';

type SavedAction =
  | { kind: 'restore' | 'delete' }
  | { kind: 'restore-files' | 'delete-files'; files: readonly StashFile[] }
  | { kind: 'rename'; name: string };

export function prepareStash(
  lease: RepositoryLease,
  { id, sha }: { id: string; sha: string },
) {
  requireStashIdentity(sha);

  return {
    write({
      action,
      beforeWrite,
    }: {
      action: SavedAction;
      beforeWrite: BeforeWrite;
    }): Promise<string | null> {
      const captured =
        'files' in action
          ? { ...action, files: action.files.map((file) => ({ ...file })) }
          : { ...action };

      return lease.write(beforeWrite, async (cli) => {
        switch (captured.kind) {
          case 'restore':
            await applyStash(cli, id, sha);

            return null;
          case 'delete':
            await deleteStash(cli, id, sha);

            return null;
          case 'restore-files':
            await restoreStashFiles(cli, id, sha, captured.files);

            return null;
          case 'delete-files':
            return deleteStashFiles(cli, id, sha, captured.files);
          case 'rename':
            return renameStash(cli, id, sha, captured.name);
        }
      });
    },
  };
}
