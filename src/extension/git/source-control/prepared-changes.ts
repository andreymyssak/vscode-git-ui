import type { CommitMode, WorkingFile } from '../../../shared/source-control';
import type { BeforeWrite, RepositoryLease } from './repository';
import {
  captureSelection,
  commitSelected,
  stashSelected,
} from './selected-changes';

export async function prepareChanges(
  lease: RepositoryLease,
  options: { id: string; files: readonly WorkingFile[]; mode: CommitMode },
) {
  const { id } = options;
  const mode = { ...options.mode };
  const files = options.files.map((file) => ({ ...file }));
  const snapshot = await captureSelection(lease.cli, id, files, mode);
  const amendPublished =
    mode.kind === 'amend' &&
    snapshot.head !== null &&
    Boolean(
      (
        await lease.cli.run(id, [
          'for-each-ref',
          `--contains=${snapshot.head}`,
          '--format=%(refname)',
          'refs/remotes',
        ])
      ).trim(),
    );

  lease.current();

  return {
    amendPublished,
    write({
      kind,
      message,
      beforeWrite,
    }: {
      kind: 'commit' | 'stash';
      message: string;
      beforeWrite: BeforeWrite;
    }) {
      return lease.write(beforeWrite, (cli) =>
        kind === 'commit'
          ? commitSelected(cli, id, snapshot, message, mode)
          : stashSelected(cli, id, snapshot, message),
      );
    },
  };
}
