import type { FileIconTheme } from './file-icons';
import { isHistoryFilters } from './history-filters';
import type { HistoryPageUpdate, PanelBody, Result } from './messages';
import type {
  BranchRestoreHandle,
  BranchUpdateDecision,
  CommitRecord,
  FileChange,
  HistoryAnnotations,
  OperationResult,
  Reference,
  RepositoryInfo,
  Scope,
  ScrollAnchor,
  WorktreeInfo,
} from './model';
import { isRecord } from './validation';

const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
const isOptionalString = (value: unknown) =>
  value === undefined || isString(value);
const isOptionalBoolean = (value: unknown) =>
  value === undefined || typeof value === 'boolean';
const isOptionalFilters = (value: unknown) =>
  value === undefined || isHistoryFilters(value);

function isRepository(value: unknown): value is RepositoryInfo {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.label) &&
    isString(value.rootUri) &&
    isNullableString(value.headSha) &&
    isNullableString(value.branch)
  );
}

function isOperationDescription(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.section === undefined ||
      value.section === 'branches' ||
      value.section === 'history' ||
      value.section === 'worktrees') &&
    isString(value.label) &&
    value.label.length > 0 &&
    isStringArray(value.refIds) &&
    value.refIds.every((ref) => /^refs\/(?:heads|remotes|tags)\/.+/.test(ref))
  );
}

function isScope(value: unknown): value is Scope {
  if (!isRecord(value)) return false;

  return (
    value.kind === 'head' ||
    value.kind === 'all' ||
    (value.kind === 'ref' && isString(value.refId)) ||
    (value.kind === 'commit' && isString(value.sha))
  );
}

function isCommit(value: unknown): value is CommitRecord {
  return (
    isRecord(value) &&
    isString(value.sha) &&
    isStringArray(value.parents) &&
    isString(value.message) &&
    isNullableString(value.authorName) &&
    isNullableString(value.authorEmail) &&
    isNullableString(value.authorDate) &&
    isNullableString(value.commitDate)
  );
}

function isReference(value: unknown): value is Reference {
  if (!isRecord(value)) return false;
  const tracking = value.tracking;

  return (
    isString(value.id) &&
    isString(value.name) &&
    (value.kind === 'local' ||
      value.kind === 'remote' ||
      value.kind === 'tag') &&
    isString(value.sha) &&
    isNullableString(value.remote) &&
    (tracking === undefined ||
      (isRecord(tracking) &&
        isString(tracking.upstream) &&
        (tracking.ahead === null || isFiniteNumber(tracking.ahead)) &&
        (tracking.behind === null || isFiniteNumber(tracking.behind))))
  );
}

function isHistoryAnnotations(value: unknown): value is HistoryAnnotations {
  return (
    isRecord(value) &&
    isStringArray(value.currentBranch) &&
    (value.user === null ||
      (isRecord(value.user) &&
        isString(value.user.name) &&
        isString(value.user.email)))
  );
}

function isHistoryPage(value: unknown): value is HistoryPageUpdate {
  if (!isRecord(value)) return false;

  return (
    Array.isArray(value.commits) &&
    value.commits.every(isCommit) &&
    (value.refs === undefined ||
      (Array.isArray(value.refs) && value.refs.every(isReference))) &&
    isNullableString(value.nextCursor) &&
    isString(value.scopeId) &&
    (value.annotations === undefined || isHistoryAnnotations(value.annotations))
  );
}

function isAnchor(value: unknown): value is ScrollAnchor | null {
  return (
    value === null ||
    (isRecord(value) &&
      isString(value.sha) &&
      isFiniteNumber(value.offset) &&
      value.offset >= 0 &&
      value.offset < 22)
  );
}

function isFile(value: unknown): value is FileChange {
  return (
    isRecord(value) &&
    isString(value.id) &&
    (value.status === 'added' ||
      value.status === 'modified' ||
      value.status === 'deleted' ||
      value.status === 'renamed') &&
    isNullableString(value.oldPath) &&
    isNullableString(value.newPath)
  );
}

function isWorktree(value: unknown): value is WorktreeInfo {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.rootUri) &&
    isNullableString(value.branch) &&
    typeof value.current === 'boolean' &&
    typeof value.available === 'boolean' &&
    isOptionalBoolean(value.main) &&
    isOptionalBoolean(value.locked) &&
    isOptionalString(value.deletionBlocked)
  );
}

function isBranchRestore(value: unknown): value is BranchRestoreHandle {
  return (
    isRecord(value) &&
    isString(value.name) &&
    isString(value.token) &&
    (value.names === undefined || isStringArray(value.names))
  );
}

function isUpdateDecision(value: unknown): value is BranchUpdateDecision {
  if (
    !isRecord(value) ||
    (value.kind !== 'checkout' && value.kind !== 'integrate')
  )
    return false;
  const continuation = value.continuation;

  if (!isRecord(continuation)) return false;
  const { target, checkout } = continuation;
  const isSha = (sha: unknown) =>
    isString(sha) && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha);

  return (
    isRecord(target) &&
    target.kind === 'update-branch' &&
    isString(target.refId) &&
    /^refs\/heads\/.+/.test(target.refId) &&
    isSha(target.expectedSha) &&
    isString(target.expectedUpstream) &&
    /^refs\/(?:heads|remotes)\/.+/.test(target.expectedUpstream) &&
    isRecord(checkout) &&
    (checkout.ref === null ||
      (isString(checkout.ref) && /^refs\/heads\/.+/.test(checkout.ref))) &&
    isSha(checkout.sha) &&
    isSha(continuation.fetchedSha) &&
    isFiniteNumber(continuation.incomingCount) &&
    Number.isSafeInteger(continuation.incomingCount) &&
    continuation.incomingCount > 0 &&
    isString(continuation.remote) &&
    continuation.remote.length > 0 &&
    isString(continuation.remoteRef) &&
    continuation.remoteRef.length > 0
  );
}

function isOperation(value: unknown): value is OperationResult {
  if (
    !isRecord(value) ||
    !(
      value.backend === null ||
      value.backend === 'api' ||
      value.backend === 'cli' ||
      value.backend === 'command'
    )
  )
    return false;
  if (value.kind === 'cancelled') return true;
  if (
    value.branchRestore !== undefined &&
    !isBranchRestore(value.branchRestore)
  )
    return false;
  if (value.kind === 'success')
    return (
      isOptionalString(value.message) && isOptionalString(value.replacementSha)
    );

  return (
    (value.kind === 'error' || value.kind === 'conflict') &&
    isString(value.message) &&
    (value.updateDecision === undefined ||
      isUpdateDecision(value.updateDecision)) &&
    (value.recovery === undefined || value.recovery === 'source-control')
  );
}

const isStringMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every(isString);

function isIconTheme(value: unknown): value is FileIconTheme {
  if (
    !isRecord(value) ||
    !isRecord(value.definitions) ||
    !isRecord(value.associations) ||
    !isRecord(value.languages)
  )
    return false;
  const associations = value.associations;
  const languages = value.languages;

  return (
    Object.values(value.definitions).every(
      (icon) =>
        isRecord(icon) &&
        isOptionalString(icon.className) &&
        isOptionalString(icon.uri),
    ) &&
    isOptionalString(associations.file) &&
    isOptionalString(associations.folder) &&
    isOptionalString(associations.folderExpanded) &&
    [
      associations.fileNames,
      associations.fileExtensions,
      associations.languageIds,
      associations.folderNames,
      associations.folderNamesExpanded,
    ].every(isStringMap) &&
    isStringMap(languages.fileNames) &&
    isStringMap(languages.extensions) &&
    (languages.patterns === undefined ||
      (Array.isArray(languages.patterns) &&
        languages.patterns.every((pattern) => {
          if (
            !isRecord(pattern) ||
            !isString(pattern.source) ||
            !isString(pattern.language) ||
            typeof pattern.matchPath !== 'boolean' ||
            typeof pattern.configured !== 'boolean'
          )
            return false;
          try {
            new RegExp(pattern.source, 'i');

            return true;
          } catch {
            return false;
          }
        })))
  );
}

// Every message variant has a validator; adding a variant requires handling it here.
const validators = {
  'file-icon-theme': (body) =>
    (body.theme === null || isIconTheme(body.theme)) &&
    isNullableString(body.stylesheet),
  filters: (body) => isHistoryFilters(body.filters),
  reveal: (body) => isString(body.sha),
  selection: (body) =>
    isNullableString(body.sha) &&
    isNullableString(body.parentSha) &&
    isNullableString(body.filePath) &&
    isAnchor(body.anchor),
  notice: (body) => isString(body.message),
  setup: (body) =>
    (body.state === 'ready' ||
      body.state === 'no-repository' ||
      body.state === 'git-disabled' ||
      body.state === 'untrusted') &&
    isString(body.message) &&
    Array.isArray(body.repositories) &&
    body.repositories.every(isRepository),
  loading: (body) =>
    isScope(body.scope) &&
    isString(body.text) &&
    isRepository(body.repository) &&
    isOptionalBoolean(body.preserve) &&
    isOptionalFilters(body.filters),
  history: (body) =>
    isHistoryPage(body.page) &&
    typeof body.append === 'boolean' &&
    isScope(body.scope) &&
    isString(body.text) &&
    isRepository(body.repository) &&
    isOptionalFilters(body.filters) &&
    isOptionalBoolean(body.restoring),
  'history-settled': () => true,
  'history-enrichment': (body) =>
    isRecord(body.enrichment) &&
    isString(body.enrichment.scopeId) &&
    isStringArray(body.enrichment.shas) &&
    (body.enrichment.refs === undefined ||
      (Array.isArray(body.enrichment.refs) &&
        body.enrichment.refs.every(isReference))) &&
    isHistoryAnnotations(body.enrichment.annotations),
  'history-interrupted': () => true,
  'focus-log': () => true,
  details: (body) => isCommit(body.commit),
  files: (body) =>
    isString(body.sha) &&
    isNullableString(body.parentSha) &&
    Array.isArray(body.files) &&
    body.files.every(isFile),
  'files-error': (body) =>
    isString(body.sha) &&
    isNullableString(body.parentSha) &&
    isString(body.message),
  worktrees: (body) =>
    Array.isArray(body.worktrees) && body.worktrees.every(isWorktree),
  'worktrees-loading': (body) => typeof body.loading === 'boolean',
  'worktrees-error': (body) => isString(body.message),
  operation: (body) => isOperation(body.result),
  'operation-progress': (body) =>
    body.operation === null ||
    (isRecord(body.operation) &&
      isOperationDescription(body.operation) &&
      (body.operation.queued === undefined ||
        (Array.isArray(body.operation.queued) &&
          body.operation.queued.every(isOperationDescription))) &&
      (body.operation.phase === 'waiting' ||
        body.operation.phase === 'running' ||
        body.operation.phase === 'refreshing')),
  error: (body) => isString(body.message),
  references: (body) =>
    Array.isArray(body.references) &&
    body.references.every(isReference) &&
    (body.repository === undefined || isRepository(body.repository)),
} satisfies Record<
  PanelBody['kind'],
  (body: Record<string, unknown>) => boolean
>;

function isPanelBody(value: unknown): value is PanelBody {
  if (!isRecord(value) || !isString(value.kind)) return false;
  const entry = Object.entries(validators).find(
    ([kind]) => kind === value.kind,
  );

  return entry?.[1](value) ?? false;
}

/** Parse untyped postMessage data once, before it enters webview state. */
export function parsePanelResult(value: unknown): Result<PanelBody> | null {
  if (
    !isRecord(value) ||
    !isString(value.requestId) ||
    !isString(value.repositoryId) ||
    !isFiniteNumber(value.generation) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !isPanelBody(value.body)
  )
    return null;

  return {
    requestId: value.requestId,
    repositoryId: value.repositoryId,
    generation: value.generation,
    body: value.body,
  };
}
