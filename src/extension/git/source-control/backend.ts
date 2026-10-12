import type {
  CommitMode,
  Stash,
  StashFile,
  WorkingFile,
} from '../../../shared/source-control';
import { getGitApi } from '../api';
import { stashChangeUris, workingChangeUris } from './comparisons';
import { prepareChanges } from './prepared-changes';
import { prepareDiscard } from './prepared-discard';
import { prepareRollback } from './prepared-rollback';
import { prepareStash } from './prepared-stash';
import { createRepositoryAccess } from './repository';
import { readSelectedPatch, validateSelectedPatch } from './selected-patch';
import { readStashes, readStashFiles } from './stashes';
import { readWorkingChanges } from './working-changes';

export async function createSourceControlBackend(signal?: AbortSignal) {
  const access = await getGitApi(signal);

  signal?.throwIfAborted();
  const repositories = createRepositoryAccess(access);

  return {
    repositories: repositories.repositories,
    subscribeRepositories: repositories.subscribeRepositories,
    subscribe: repositories.subscribe,
    dispose: repositories.dispose,
    root: (id: string) => repositories.lease(id).root,
    status: (id: string) => repositories.lease(id).current().status(),
    headCommit: (id: string) =>
      repositories.lease(id).current().getCommit('HEAD'),
    workingChanges: (id: string) =>
      readWorkingChanges(repositories.lease(id).cli, id),
    stashes: (id: string) => readStashes(repositories.lease(id).cli, id),
    stashFiles: (id: string, stash: Stash) =>
      readStashFiles(repositories.lease(id).cli, id, stash),
    prepareChanges: (options: {
      id: string;
      files: readonly WorkingFile[];
      mode: CommitMode;
    }) => prepareChanges(repositories.lease(options.id), options),
    prepareStash: (options: { id: string; sha: string }) =>
      prepareStash(repositories.lease(options.id), options),
    prepareRollback: (options: { id: string; files: readonly WorkingFile[] }) =>
      prepareRollback(repositories.lease(options.id), options),
    prepareDiscard: (options: { id: string; path: string }) =>
      prepareDiscard(repositories.lease(options.id), options),
    async messagePatch(
      id: string,
      files: readonly WorkingFile[],
      cancellation?: AbortSignal,
    ) {
      const lease = repositories.lease(id);
      const patch = await readSelectedPatch(lease.cli, id, files, cancellation);

      return {
        patch,
        validate: () =>
          validateSelectedPatch(lease.cli, id, patch, cancellation),
      };
    },
    workingComparison(id: string, file: WorkingFile, index = false) {
      const lease = repositories.lease(id);

      return workingChangeUris(
        { ...access, repository: () => lease.current() },
        lease.cli,
        id,
        file,
        index,
      );
    },
    stashComparison(id: string, file: StashFile) {
      const lease = repositories.lease(id);

      return stashChangeUris(
        { ...access, repository: () => lease.current() },
        id,
        file,
      );
    },
  };
}

export type SourceControlBackend = Awaited<
  ReturnType<typeof createSourceControlBackend>
>;
