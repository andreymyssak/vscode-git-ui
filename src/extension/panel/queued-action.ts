import type { UserAction } from '../../shared/messages';
import type { QuerySession } from './queries';

/** Freeze displayed targets; a queued intent must never adopt replacement history. */
export function queuedActionCurrent(
  action: UserAction,
  session: QuerySession,
): () => boolean {
  const snapshot = () => {
    const refIds =
      'refIds' in action
        ? action.refIds
        : 'refId' in action && action.refId
          ? [action.refId]
          : [];
    const references = refIds.map((id) => {
      const ref = session.refs.get(id);

      return ref ? [ref.id, ref.sha, ref.tracking?.upstream] : null;
    });
    const head = [
      session.repositoryInfo?.branch,
      session.repositoryInfo?.headSha,
    ];

    switch (action.kind) {
      case 'delete-worktrees':
        return action.worktreeIds.map((id) => session.worktrees.get(id));
      case 'cherry-pick-files':
      case 'revert-files':
        return [
          head,
          session.selection,
          action.fileIds.map((id) => session.files.get(id)),
        ];
      case 'copy-sha':
      case 'cherry-pick':
      case 'branch-from-commit':
      case 'tag-from-commit':
      case 'edit-commit-message':
      case 'cherry-pick-commits':
      case 'squash-commits':
      case 'drop-commits':
        return [
          head,
          session.selectedSha,
          session.selectedShas,
          ('shas' in action ? action.shas : [action.sha]).map((sha) =>
            session.commits.get(sha),
          ),
        ];
      case 'merge-branch':
      case 'rebase-branch':
        return [head, references];
      case 'create-worktree':
        return action.refId ? references : head;
      case 'update-branch':
      case 'checkout':
      case 'create-branch':
      case 'create-branch-checkout':
      case 'rename-branch':
      case 'delete-branch':
      case 'delete-branches':
      case 'copy-branch':
        return references;
      case 'fetch-all':
        return null;
      default: {
        const exhaustive: never = action;

        return exhaustive;
      }
    }
  };

  const captured = JSON.stringify(snapshot());

  return () => JSON.stringify(snapshot()) === captured;
}
