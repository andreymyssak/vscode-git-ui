import type { RepositoryInfo } from '../../shared/model';
import type { Loaded } from '../../shared/source-control';
import { diagnostics } from '../diagnostics';
import type { SourceControlBackend } from '../git/source-control/index';
import { readWithCancellation } from '../read-cancellation';
import type { SourceControlModel } from './model';
import type { SourceControlNotifications } from './notifications';
import type { SourceControlRefreshes } from './refresh-targets';
import { type RefreshSection, type RefreshTargets } from './refresh-targets';
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
  targets,
  ownership,
}: {
  runtime: SourceControlBackend;
  targets: RefreshTargets;
  ownership: SourceControlRefreshes;
  model: SourceControlModel;
  infos: RepositoryInfo[];
  notifications: SourceControlNotifications;
  isCurrent: () => boolean;
  publish: () => void;
  settled: (id: string, source: 'changes' | 'stashes' | 'operation') => void;
}): Promise<void> {
  const update = async <T>(
    id: string,
    section: RefreshSection,
    read: (signal: AbortSignal) => Promise<T[]>,
    apply: (state: Loaded<T>) => void,
  ) => {
    const owner = ownership.begin(id, section);
    const started = performance.now();

    diagnostics.record('read.started', {
      repositoryId: id,
      source: section,
      generation: owner.generation,
    });
    try {
      const state = await loaded(
        readWithCancellation(() => read(owner.signal), owner.signal),
      );

      if (!owner.current() || !isCurrent()) {
        diagnostics.record('read.discarded', {
          repositoryId: id,
          source: section,
          generation: owner.generation,
          outcome: 'superseded',
        });

        return;
      }

      apply(state);
      settled(id, section);
      publish();
      diagnostics.record('read.finished', {
        repositoryId: id,
        source: section,
        generation: owner.generation,
        elapsedMs: performance.now() - started,
        outcome: state.kind === 'error' ? 'error' : 'success',
      });
    } finally {
      owner.finish();
    }
  };

  await Promise.all(
    infos.flatMap((info) =>
      [...(targets.get(info.id) ?? [])].map((section) => {
        switch (section) {
          case 'changes':
            return update(
              info.id,
              section,
              (signal) => runtime.workingChanges(info.id, signal),
              (changes) => {
                model.updateChanges(info.id, changes);
                notifications.load(
                  info.id,
                  'changes',
                  `Changes in ${info.label}`,
                  changes,
                );
              },
            );
          case 'stashes':
            return update(
              info.id,
              section,
              (signal) => runtime.stashes(info.id, signal),
              (stashes) => {
                model.updateStashes(info.id, stashes);
                notifications.load(
                  info.id,
                  'stashes',
                  `Stashes in ${info.label}`,
                  stashes,
                );
              },
            );
          case 'operation':
            return update(
              info.id,
              section,
              (signal) => runtime.operation(info.id, signal),
              (operation) => {
                model.requireRepository(info.id).operation = operation;
              },
            );
        }
      }),
    ),
  );
}
