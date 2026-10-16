import type { SourceControlBackend } from '../git/source-control/index';
import type { SourceControlModel } from './model';
import type { SourceControlNotifications } from './notifications';
import { loaded } from './state';
import { requireLiveRepository } from './writes';

/** A stash detail read may publish only into the repository lifetime that issued it. */
export async function loadStash({
  runtime,
  model,
  id,
  sha,
  closed,
  publish,
  notifications,
}: {
  runtime: SourceControlBackend;
  model: SourceControlModel;
  id: string;
  sha: string;
  closed(this: void): boolean;
  publish(this: void): void;
  notifications: SourceControlNotifications;
}): Promise<void> {
  const owner = requireLiveRepository(runtime, model, id);
  const stash = model.requireStash(id, sha);

  if (stash.files?.kind === 'ready' || stash.files?.kind === 'loading') return;
  stash.files = { kind: 'loading' };
  publish();
  const files = await loaded(runtime.stashFiles(id, stash));

  if (closed() || model.repositories.get(id) !== owner) return;
  const current = model.repositories.get(id);
  const target =
    current?.stashes.kind === 'ready'
      ? current.stashes.items.find((item) => item.sha === sha)
      : undefined;

  if (target) {
    target.files = files;
    notifications.load(
      id,
      `stash:${sha}`,
      `Stash ${stash.message || stash.selector}`,
      files,
    );
    publish();
  }
}
