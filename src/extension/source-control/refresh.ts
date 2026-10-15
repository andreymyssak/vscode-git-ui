import type { RepositoryInfo } from '../../shared/model';
import type { Loaded } from '../../shared/source-control';
import type { SourceControlBackend } from '../git/source-control/index';
import type { SourceControlModel } from './model';
import type { SourceControlNotifications } from './notifications';
import { loaded } from './state';

/** File status must not wait for unrelated stash or operation reads. */
export async function refreshRepositories({
  runtime,
  model,
  infos,
  notifications,
  isCurrent,
  publish,
  settled,
}: {
  runtime: SourceControlBackend;
  model: SourceControlModel;
  infos: RepositoryInfo[];
  notifications: SourceControlNotifications;
  isCurrent: () => boolean;
  publish: () => void;
  settled: (id: string, source: 'changes' | 'stashes' | 'operation') => void;
}): Promise<void> {
  const update = async <T>(
    read: Promise<T[]>,
    apply: (state: Loaded<T>) => void,
  ) => {
    const state = await loaded(read);

    if (!isCurrent()) return;
    apply(state);
    publish();
  };

  await Promise.all(
    infos.flatMap((info) => [
      update(runtime.workingChanges(info.id), (changes) => {
        model.updateChanges(info.id, changes);
        notifications.load(
          info.id,
          'changes',
          `Changes in ${info.label}`,
          changes,
        );
        settled(info.id, 'changes');
      }),
      update(runtime.stashes(info.id), (stashes) => {
        model.updateStashes(info.id, stashes);
        notifications.load(
          info.id,
          'stashes',
          `Stashes in ${info.label}`,
          stashes,
        );
        settled(info.id, 'stashes');
      }),
      update(runtime.operation(info.id), (operation) => {
        model.requireRepository(info.id).operation = operation;
        settled(info.id, 'operation');
      }),
    ]),
  );
}
