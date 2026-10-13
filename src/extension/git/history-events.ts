import type { GitRef, GitRepository } from './api';

type HistoryRepository = Pick<GitRepository, 'getRefs'> & {
  state: Pick<GitRepository['state'], 'HEAD' | 'worktrees' | 'remotes'>;
};

/** Status also fires for editor/index activity; only history metadata revokes a query. */
export function historyChangeFilter(
  repository: HistoryRepository,
  changed: () => void,
): { check(): Promise<void>; settled(): Promise<void>; dispose(): void } {
  const ref = (value: GitRef | undefined) =>
    value
      ? [value.type, value.name, value.commit, value.remote, value.upstream]
      : null;
  const snapshot = () => {
    const metadata = {
      head: ref(repository.state.HEAD),
      worktrees: [...repository.state.worktrees].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
      remotes: [...repository.state.remotes].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    };

    // state.refs is deprecated and returns an empty array in the supported VS Code.
    return repository.getRefs({}).then(
      (refs) =>
        JSON.stringify({
          ...metadata,
          refs: refs
            .map(ref)
            .sort((left, right) =>
              JSON.stringify(left).localeCompare(JSON.stringify(right)),
            ),
        }),
      () => null,
    );
  };

  let previous: string | null | undefined;
  let pending: Promise<void> | null = null;
  let dirty = true;
  let active = true;
  const schedule = () => {
    if (pending || !active) return;
    pending = Promise.resolve()
      .then(async () => {
        while (dirty && active) {
          dirty = false;
          const current = await snapshot();

          if (!active) return;
          const notify =
            previous !== undefined &&
            (previous === null || current === null || previous !== current);

          previous = current;
          if (notify) changed();
        }
      })
      .finally(() => {
        pending = null;
        if (dirty && active) schedule();
      });
  };

  const settled = async () => {
    while (active && pending) await pending;
  };

  schedule();

  return {
    settled,
    check() {
      if (active) {
        dirty = true;
        schedule();
      }

      return settled();
    },
    dispose() {
      active = false;
      dirty = false;
      previous = undefined;
    },
  };
}
