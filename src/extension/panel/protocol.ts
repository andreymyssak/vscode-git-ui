import { isBranchDeletionSelection } from '../../shared/branch-selection';
import { isHistoryFilters } from '../../shared/history-filters';
import type {
  BranchActionKind,
  CommitActionKind,
  Request,
  RequestBody,
  UserAction,
  WorktreeActionKind,
} from '../../shared/messages';
import type { Scope } from '../../shared/model';
import { isRecord } from '../../shared/validation';
import { isWorktreeSelection } from '../../shared/worktree-selection';

function filterKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    keys(value, expected) ||
    (keys(value, [...expected, 'filters']) && isHistoryFilters(value.filters))
  );
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isText(value: unknown, max = 4096): value is string {
  return (
    typeof value === 'string' && value.length <= max && !value.includes('\0')
  );
}

function isSha(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value)
  );
}

function commitRange(value: Record<string, unknown>, minimum = 1): boolean {
  return (
    Array.isArray(value.shas) &&
    value.shas.length >= minimum &&
    value.shas.every(isSha) &&
    new Set(value.shas.map((item: string) => item.toLowerCase())).size ===
      value.shas.length &&
    isSha(value.activeSha) &&
    value.shas.includes(value.activeSha)
  );
}

function isScope(value: unknown): value is Scope {
  if (!isRecord(value)) return false;
  if (value.kind === 'head' || value.kind === 'all')
    return keys(value, ['kind']);
  if (value.kind === 'ref')
    return keys(value, ['kind', 'refId']) && isText(value.refId);
  if (value.kind === 'commit')
    return keys(value, ['kind', 'sha']) && isSha(value.sha);

  return false;
}

function isUserAction(value: unknown): value is UserAction {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'delete-worktrees':
      return (
        keys(value, ['kind', 'worktreeIds']) &&
        isWorktreeSelection(value.worktreeIds)
      );
    case 'fetch-all':
      return keys(value, ['kind']);
    case 'delete-branches':
      return (
        keys(value, ['kind', 'refIds']) &&
        isBranchDeletionSelection(value.refIds)
      );
    case 'create-worktree':
      return (
        keys(value, ['kind']) ||
        (keys(value, ['kind', 'refId']) &&
          isText(value.refId) &&
          value.refId.length > 0)
      );
    case 'update-branch':
    case 'merge-branch':
    case 'rebase-branch':
    case 'checkout':
    case 'create-branch':
    case 'copy-branch':
    case 'rename-branch':
    case 'delete-branch':
      return keys(value, ['kind', 'refId']) && isText(value.refId);
    case 'cherry-pick':
    case 'branch-from-commit':
    case 'tag-from-commit':
    case 'copy-sha':
    case 'edit-commit-message':
      return keys(value, ['kind', 'sha']) && isSha(value.sha);
    case 'squash-commits':
      return (
        keys(value, ['kind', 'shas', 'activeSha']) && commitRange(value, 2)
      );
    case 'cherry-pick-commits':
    case 'drop-commits':
      return keys(value, ['kind', 'shas', 'activeSha']) && commitRange(value);
    default:
      return false;
  }
}

export function branchMenuRequest(
  kind: BranchActionKind,
  value: unknown,
): Request<RequestBody> | null {
  if (!isRecord(value)) return null;

  if (kind === 'delete-branches') {
    if (
      !isBranchDeletionSelection(value.refIds) ||
      value.refSelectionCount !== value.refIds.length ||
      !value.refIds.includes(String(value.refId))
    )
      return null;

    return parseRequest({
      requestId: 'branch-menu',
      repositoryId: value.repositoryId,
      generation: value.generation,
      body: {
        kind: 'action',
        action: { kind, refIds: value.refIds },
      },
    });
  }

  if (
    (value.refSelectionCount !== undefined && value.refSelectionCount !== 1) ||
    (value.refIds !== undefined &&
      (!Array.isArray(value.refIds) ||
        value.refIds.length !== 1 ||
        value.refIds[0] !== value.refId))
  )
    return null;

  return parseRequest({
    requestId: 'branch-menu',
    repositoryId: value.repositoryId,
    generation: value.generation,
    body: { kind: 'action', action: { kind, refId: value.refId } },
  });
}

export function commitMenuRequest(
  kind: CommitActionKind,
  value: unknown,
): Request<RequestBody> | null {
  if (!isRecord(value)) return null;

  if (
    kind === 'squash-commits' ||
    kind === 'drop-commits' ||
    (kind === 'cherry-pick' &&
      value.commitSelectionCount !== 1 &&
      value.commitShas !== undefined)
  ) {
    if (
      !Array.isArray(value.commitShas) ||
      value.commitSelectionCount !== value.commitShas.length
    )
      return null;

    return parseRequest({
      requestId: 'commit-menu',
      repositoryId: value.repositoryId,
      generation: value.generation,
      body: {
        kind: 'action',
        action: {
          kind: kind === 'cherry-pick' ? 'cherry-pick-commits' : kind,
          shas: value.commitShas,
          activeSha: value.commitSha,
        },
      },
    });
  }

  if (
    value.commitSelectionCount !== undefined &&
    value.commitSelectionCount !== 1
  )
    return null;
  if (
    value.commitShas !== undefined &&
    (!Array.isArray(value.commitShas) ||
      value.commitShas.length !== 1 ||
      value.commitShas[0] !== value.commitSha)
  )
    return null;

  return parseRequest({
    requestId: 'commit-menu',
    repositoryId: value.repositoryId,
    generation: value.generation,
    body: { kind: 'action', action: { kind, sha: value.commitSha } },
  });
}

function selection(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      keys(value, ['sha', 'parentSha', 'filePath']) &&
      isSha(value.sha) &&
      (value.parentSha === null || isSha(value.parentSha)) &&
      (value.filePath === null || isText(value.filePath, 8192)))
  );
}

function anchor(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      keys(value, ['sha', 'offset']) &&
      isSha(value.sha) &&
      typeof value.offset === 'number' &&
      Number.isFinite(value.offset) &&
      value.offset >= 0 &&
      value.offset < 22)
  );
}

function isRequestBody(value: unknown): value is RequestBody {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'ready':
      return (
        keys(value, ['kind', 'savedRepositoryId']) &&
        (value.savedRepositoryId === null ||
          isText(value.savedRepositoryId, 8192))
      );
    case 'choose-repository':
    case 'choose-authors':
    case 'invalid-date-filter':
    case 'refresh':
    case 'source-control':
    case 'trust':
      return keys(value, ['kind']);
    case 'worktrees':
      return (
        keys(value, ['kind']) ||
        (keys(value, ['kind', 'retry']) && value.retry === true)
      );
    case 'history':
      return (
        filterKeys(value, ['kind', 'scope', 'text', 'cursor']) &&
        isScope(value.scope) &&
        isText(value.text) &&
        (value.cursor === null || isText(value.cursor, 128))
      );
    case 'select-commit':
      return keys(value, ['kind', 'sha']) && isSha(value.sha);
    case 'select-commits':
      return keys(value, ['kind', 'shas', 'activeSha']) && commitRange(value);
    case 'load-parent':
      return (
        keys(value, ['kind', 'sha', 'parentSha']) &&
        isSha(value.sha) &&
        (value.parentSha === null || isSha(value.parentSha))
      );
    case 'open-file':
      return (
        keys(value, ['kind', 'fileId', 'preview']) &&
        isText(value.fileId, 128) &&
        typeof value.preview === 'boolean'
      );
    case 'restore':
      return (
        filterKeys(value, ['kind', 'scope', 'text', 'selection', 'anchor']) &&
        isScope(value.scope) &&
        isText(value.text) &&
        selection(value.selection) &&
        anchor(value.anchor)
      );
    case 'anchor':
      return keys(value, ['kind', 'anchor']) && anchor(value.anchor);
    case 'go-to':
      return keys(value, ['kind', 'input']) && isText(value.input);
    case 'action':
      return keys(value, ['kind', 'action']) && isUserAction(value.action);
    case 'open-worktree':
      return (
        keys(value, ['kind', 'worktreeId', 'newWindow']) &&
        typeof value.newWindow === 'boolean' &&
        isText(value.worktreeId, 128)
      );
    default:
      return false;
  }
}

export function parseRequest(value: unknown): Request<RequestBody> | null {
  if (
    !isRecord(value) ||
    !keys(value, ['requestId', 'repositoryId', 'generation', 'body']) ||
    !isText(value.requestId, 128) ||
    !isText(value.repositoryId, 8192) ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !isRequestBody(value.body)
  )
    return null;

  return {
    requestId: value.requestId,
    repositoryId: value.repositoryId,
    generation: value.generation,
    body: value.body,
  };
}

export function worktreeMenuRequest(
  kind: WorktreeActionKind,
  value: unknown,
): Request<RequestBody> | null {
  if (
    !isRecord(value) ||
    !isWorktreeSelection(value.worktreeIds) ||
    value.worktreeSelectionCount !== value.worktreeIds.length ||
    !value.worktreeIds.includes(String(value.worktreeId))
  )
    return null;
  if (kind !== 'delete-worktrees' && value.worktreeIds.length !== 1)
    return null;

  return parseRequest({
    requestId: 'worktree-menu',
    repositoryId: value.repositoryId,
    generation: value.generation,
    body:
      kind === 'delete-worktrees'
        ? {
            kind: 'action',
            action: { kind, worktreeIds: value.worktreeIds },
          }
        : {
            kind: 'open-worktree',
            worktreeId: value.worktreeId,
            newWindow: kind === 'open-worktree-new',
          },
  });
}
