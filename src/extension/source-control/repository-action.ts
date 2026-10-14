import type {
  SourceControlRepositoryAction,
  SourceControlRequest,
} from '../../shared/source-control';
import { isSourceControlRepositoryAction } from '../../shared/source-control';
import type { SourceControlBackend } from '../git/source-control/index';
import { askBranchName } from '../native/dialogs';
import type { SourceControlModel } from './model';
import { requireLiveRepository } from './writes';

export const repositoryActionTitles = {
  pull: 'Pulling changes',
  push: 'Pushing commits',
  fetch: 'Fetching remote branches',
  'checkout-branch': 'Checking out branch',
  'new-branch': 'Creating branch',
  'new-branch-checkout': 'Creating and checking out branch',
  'new-branch-from': 'Creating and checking out branch',
  'merge-current': 'Merging branch',
  'rebase-current': 'Rebasing branch',
  'rename-current-branch': 'Renaming branch',
  'delete-local-branch': 'Deleting branch',
  'delete-remote-branch': 'Deleting remote branch',
  'publish-branch': 'Publishing branch',
  'create-tag': 'Creating tag',
  'delete-tag': 'Deleting tag',
  'delete-remote-tag': 'Deleting remote tag',
  'push-tags': 'Pushing tags',
} satisfies Record<SourceControlRepositoryAction, string>;

export function isRepositoryAction(
  request: SourceControlRequest,
): request is Extract<
  SourceControlRequest,
  { kind: SourceControlRepositoryAction }
> {
  return isSourceControlRepositoryAction(request.kind);
}

export async function runRepositoryAction(options: {
  runtime: SourceControlBackend;
  model: SourceControlModel;
  request: { repositoryId: string; kind: SourceControlRepositoryAction };
}): Promise<void> {
  const { runtime, model, request } = options;
  const id = request.repositoryId;
  const beforeWrite = () => requireLiveRepository(runtime, model, id);

  if (request.kind === 'new-branch') {
    const branch = await runtime.prepareBranchCreation(id);
    const name = await askBranchName();

    if (name !== null) await branch.write({ name, beforeWrite });

    return;
  }

  return runtime.repositoryAction({
    id,
    kind: request.kind,
    beforeWrite,
  });
}
