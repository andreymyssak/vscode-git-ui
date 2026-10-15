import type { ActiveLogOperation, UserAction } from '../../shared/messages';

/** Copying is read-only; every Git change shares the Log's operation lifecycle. */
export function describeLogAction(
  action: UserAction,
): Pick<ActiveLogOperation, 'label' | 'refIds' | 'section'> | null {
  const section: NonNullable<ActiveLogOperation['section']> =
    action.kind === 'create-worktree' || action.kind === 'delete-worktrees'
      ? 'worktrees'
      : [
            'cherry-pick',
            'cherry-pick-commits',
            'cherry-pick-files',
            'revert-files',
            'edit-commit-message',
            'squash-commits',
            'drop-commits',
            'branch-from-commit',
            'tag-from-commit',
          ].includes(action.kind)
        ? 'history'
        : 'branches';
  const describe = (label: string, refIds: string[] = []) => ({
    label,
    refIds,
    section,
  });
  const name =
    'refId' in action
      ? action.refId?.replace(/^refs\/(?:heads|remotes|tags)\//, '')
      : undefined;
  const refs = 'refId' in action && action.refId ? [action.refId] : [];

  switch (action.kind) {
    case 'copy-branch':
    case 'copy-sha':
      return null;
    case 'update-branch':
      return describe(`Updating ${name}…`, refs);
    case 'checkout':
      return describe(`Checking out ${name}…`, refs);
    case 'merge-branch':
      return describe(`Merging ${name}…`, refs);
    case 'rebase-branch':
      return describe(`Rebasing onto ${name}…`, refs);
    case 'create-branch':
      return describe('Creating branch…', refs);
    case 'create-branch-checkout':
      return describe('Creating and checking out branch…', refs);
    case 'rename-branch':
      return describe(`Renaming ${name}…`, refs);
    case 'delete-branch':
      return describe(`Deleting ${name}…`, refs);
    case 'delete-branches':
      return describe(
        `Deleting ${action.refIds.length} branches…`,
        action.refIds,
      );
    case 'fetch-all':
      return describe('Fetching remotes…');
    case 'create-worktree':
      return describe('Creating worktree…', refs);
    case 'delete-worktrees':
      return describe(
        `Deleting ${action.worktreeIds.length === 1 ? 'worktree' : 'worktrees'}…`,
      );
    case 'branch-from-commit':
      return describe('Creating branch…');
    case 'tag-from-commit':
      return describe('Creating tag…');
    case 'cherry-pick':
    case 'cherry-pick-commits':
      return describe('Cherry-picking commits…');
    case 'cherry-pick-files':
      return describe('Cherry-picking selected changes…');
    case 'revert-files':
      return describe('Reverting selected changes…');
    case 'edit-commit-message':
      return describe('Editing commit message…');
    case 'squash-commits':
      return describe('Squashing commits…');
    case 'drop-commits':
      return describe('Dropping commits…');
    default: {
      const exhaustive: never = action;

      return exhaustive;
    }
  }
}
