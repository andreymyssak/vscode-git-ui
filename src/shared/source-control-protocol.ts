import type { RepositoryInfo } from './model';
import type {
  Loaded,
  SourceControlOperation,
  SourceControlRepository,
  SourceControlRequest,
  SourceControlResponse,
  SourceControlState,
  StashEntry,
  StashFile,
  StashFileKey,
  WorkingFile,
} from './source-control';
import { isSourceControlRepositoryAction } from './source-control';
import { isRecord } from './validation';

const text = (value: unknown): value is string => typeof value === 'string';
const nullableText = (value: unknown): value is string | null =>
  value === null || text(value);
const identity = (value: unknown): value is string =>
  text(value) && value.length > 0 && value.length <= 8192;
const sha = (value: unknown): value is string =>
  text(value) && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value);
const tab = (value: unknown) => value === 'commit' || value === 'stash';

function path(value: unknown): value is string {
  return (
    identity(value) &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    value
      .split('/')
      .every(
        (part) =>
          Boolean(part) &&
          part !== '.' &&
          part !== '..' &&
          part.toLowerCase() !== '.git',
      )
  );
}

function fileKey(value: unknown): value is StashFileKey {
  return (
    isRecord(value) &&
    path(value.path) &&
    (value.snapshot === 'working' ||
      value.snapshot === 'index' ||
      value.snapshot === 'untracked')
  );
}

function paths(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 10_000 &&
    value.every(path)
  );
}

export function parseSourceControlRequest(
  value: unknown,
): SourceControlRequest | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'refresh':
    case 'cancel-generation':
      return { kind: value.kind };
    case 'ready':
      return (value.repositoryId === null || identity(value.repositoryId)) &&
        tab(value.tab)
        ? { kind: value.kind, repositoryId: value.repositoryId, tab: value.tab }
        : null;
    case 'tab':
      return tab(value.tab) ? { kind: value.kind, tab: value.tab } : null;
  }

  if (!identity(value.repositoryId)) return null;
  const repositoryId = value.repositoryId;

  if (isSourceControlRepositoryAction(value.kind))
    return { kind: value.kind, repositoryId };

  switch (value.kind) {
    case 'abort-operation':
      return text(value.token) && /^[a-f\d]{64}$/i.test(value.token)
        ? { kind: value.kind, repositoryId, token: value.token }
        : null;
    case 'commit-selected':
    case 'stash-selected':
    case 'copy-paths':
    case 'resolve-conflicts':
    case 'accept-current':
    case 'accept-incoming':
    case 'stage-files':
    case 'unstage-files':
    case 'delete-files':
    case 'rollback':
      return paths(value.paths)
        ? { kind: value.kind, repositoryId, paths: value.paths }
        : null;
    case 'reveal-in-os':
    case 'reveal-in-explorer':
      return paths(value.paths) && path(value.path)
        ? {
            kind: value.kind,
            repositoryId,
            paths: value.paths,
            path: value.path,
          }
        : null;
    case 'repository':
    case 'commit':
    case 'stash':
    case 'stash-silently':
    case 'generate':
    case 'reveal-working':
      return { kind: value.kind, repositoryId };
    case 'amend':
      return typeof value.enabled === 'boolean'
        ? { kind: value.kind, repositoryId, enabled: value.enabled }
        : null;
    case 'message':
      return text(value.message) &&
        value.message.length <= 65_536 &&
        identity(value.editId)
        ? {
            kind: value.kind,
            repositoryId,
            message: value.message,
            editId: value.editId,
          }
        : null;
    case 'check':
      return Array.isArray(value.paths) &&
        value.paths.length <= 10_000 &&
        value.paths.every(path) &&
        typeof value.checked === 'boolean'
        ? {
            kind: value.kind,
            repositoryId,
            paths: value.paths,
            checked: value.checked,
          }
        : null;
    case 'discard-working':
      return path(value.path)
        ? { kind: value.kind, repositoryId, path: value.path }
        : null;
    case 'open-working':
      return path(value.path) && typeof value.index === 'boolean'
        ? {
            kind: value.kind,
            repositoryId,
            path: value.path,
            index: value.index,
          }
        : null;
    case 'load-stash':
    case 'restore-stash':
    case 'delete-stash':
    case 'rename-stash':
      return sha(value.sha)
        ? { kind: value.kind, repositoryId, sha: value.sha }
        : null;
    case 'open-stash-file':
      return sha(value.sha) && fileKey(value.file)
        ? { kind: value.kind, repositoryId, sha: value.sha, file: value.file }
        : null;
    case 'restore-stash-files':
    case 'delete-stash-files':
    case 'open-stash-files':
      return sha(value.sha) &&
        Array.isArray(value.files) &&
        value.files.length > 0 &&
        value.files.length <= 10_000 &&
        value.files.every(fileKey)
        ? { kind: value.kind, repositoryId, sha: value.sha, files: value.files }
        : null;
    default:
      return null;
  }
}

function loaded<T>(
  value: unknown,
  item: (entry: unknown) => entry is T,
): value is Loaded<T> {
  return (
    isRecord(value) &&
    (value.kind === 'loading' ||
      (value.kind === 'error' && text(value.message)) ||
      (value.kind === 'ready' &&
        Array.isArray(value.items) &&
        value.items.every(item)))
  );
}

function workingFile(value: unknown): value is WorkingFile {
  return (
    isRecord(value) &&
    path(value.path) &&
    path(value.originalPath) &&
    text(value.status) &&
    typeof value.staged === 'boolean' &&
    typeof value.working === 'boolean' &&
    typeof value.untracked === 'boolean'
  );
}

function stashFile(value: unknown): value is StashFile {
  return (
    isRecord(value) &&
    fileKey(value) &&
    path(value.originalPath) &&
    text(value.status) &&
    (value.oldRef === null || sha(value.oldRef)) &&
    sha(value.newRef) &&
    typeof value.deleted === 'boolean'
  );
}

function stash(value: unknown): value is StashEntry {
  return (
    isRecord(value) &&
    sha(value.sha) &&
    identity(value.viewId) &&
    text(value.selector) &&
    text(value.message) &&
    text(value.date) &&
    sha(value.base) &&
    (value.files === null || loaded(value.files, stashFile))
  );
}

function info(value: unknown): value is RepositoryInfo {
  return (
    isRecord(value) &&
    identity(value.id) &&
    text(value.label) &&
    text(value.rootUri) &&
    nullableText(value.headSha) &&
    nullableText(value.branch)
  );
}

function repository(value: unknown): value is SourceControlRepository {
  return (
    isRecord(value) &&
    info(value.info) &&
    isRecord(value.pathLabel) &&
    text(value.pathLabel.root) &&
    (value.pathLabel.separator === '/' || value.pathLabel.separator === '\\') &&
    loaded(value.changes, workingFile) &&
    loaded(value.stashes, stash) &&
    loaded(value.operation, operation) &&
    Array.isArray(value.checked) &&
    value.checked.every(path) &&
    text(value.draft) &&
    nullableText(value.draftEditId) &&
    isRecord(value.commitMode) &&
    (value.commitMode.kind === 'new' ||
      (value.commitMode.kind === 'amend' && sha(value.commitMode.headSha)))
  );
}

function operation(value: unknown): value is SourceControlOperation {
  return (
    isRecord(value) &&
    [
      'merge',
      'rebase',
      'cherry-pick',
      'revert',
      'cherry-pick-files',
      'revert-files',
      'conflicts',
    ].includes(typeof value.kind === 'string' ? value.kind : '') &&
    text(value.token) &&
    /^[a-f\d]{64}$/i.test(value.token) &&
    Array.isArray(value.paths) &&
    value.paths.length <= 10_000 &&
    value.paths.every(path)
  );
}

function state(value: unknown): value is SourceControlState {
  return (
    isRecord(value) &&
    typeof value.hoverDelay === 'number' &&
    Number.isFinite(value.hoverDelay) &&
    value.hoverDelay >= 0 &&
    Array.isArray(value.repositories) &&
    value.repositories.every(repository) &&
    nullableText(value.repositoryId) &&
    tab(value.tab) &&
    typeof value.busy === 'boolean' &&
    (value.activity === undefined ||
      value.activity === null ||
      (isRecord(value.activity) &&
        identity(value.activity.repositoryId) &&
        identity(value.activity.title))) &&
    typeof value.generating === 'boolean' &&
    (value.reveal === null ||
      (isRecord(value.reveal) &&
        identity(value.reveal.repositoryId) &&
        path(value.reveal.path) &&
        typeof value.reveal.sequence === 'number' &&
        Number.isSafeInteger(value.reveal.sequence) &&
        value.reveal.sequence > 0))
  );
}

export function parseSourceControlResponse(
  value: unknown,
): SourceControlResponse | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'source-control-draft')
    return identity(value.repositoryId) &&
      text(value.message) &&
      value.message.length <= 65536 &&
      identity(value.editId) &&
      typeof value.generating === 'boolean'
      ? {
          kind: value.kind,
          repositoryId: value.repositoryId,
          message: value.message,
          editId: value.editId,
          generating: value.generating,
        }
      : null;

  return value.kind === 'source-control-state' && state(value.state)
    ? { kind: value.kind, state: value.state }
    : null;
}
