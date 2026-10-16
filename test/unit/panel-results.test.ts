import { describe, expect, test } from 'vitest';

import type { PanelBody } from '../../src/shared/messages';
import type {
  BranchUpdateContinuation,
  CommitRecord,
  Reference,
  RepositoryInfo,
} from '../../src/shared/model';
import { parsePanelResult } from '../../src/shared/panel-result';

const sha = 'a'.repeat(40);
const repository: RepositoryInfo = {
  id: 'repository',
  label: 'Example',
  rootUri: 'file:///example',
  headSha: sha,
  branch: 'main',
};
const commit: CommitRecord = {
  sha,
  parents: [],
  message: 'Initial',
  authorName: 'John Smith',
  authorEmail: 'john.smith@example.test',
  authorDate: null,
  commitDate: null,
};
const reference: Reference = {
  id: 'refs/heads/main',
  name: 'main',
  kind: 'local',
  sha,
  remote: null,
  tracking: { upstream: 'origin/main', ahead: 0, behind: null },
};
const filters = {
  regex: false,
  matchCase: false,
  author: { kind: 'all' },
  date: 'all',
} satisfies Extract<PanelBody, { kind: 'filters' }>['filters'];
const bodies = {
  'file-icon-theme': {
    kind: 'file-icon-theme',
    theme: {
      definitions: {
        script: { className: 'script-icon' },
        file: { uri: 'https://example.test/file.svg' },
      },
      associations: {
        file: 'file',
        fileNames: {},
        fileExtensions: {},
        languageIds: {},
        folderNames: {},
        folderNamesExpanded: {},
      },
      languages: {
        fileNames: {},
        extensions: {},
        patterns: [
          {
            source: '\\.ts$',
            language: 'typescript',
            matchPath: false,
            configured: true,
          },
        ],
      },
    },
    stylesheet: 'https://example.test/icons.css',
  },
  filters: { kind: 'filters', filters },
  reveal: { kind: 'reveal', sha },
  selection: {
    kind: 'selection',
    sha,
    parentSha: null,
    filePath: null,
    anchor: { sha, offset: 1 },
  },
  notice: { kind: 'notice', message: 'Updated' },
  setup: {
    kind: 'setup',
    state: 'ready',
    message: '',
    repositories: [repository],
  },
  loading: {
    kind: 'loading',
    scope: { kind: 'head' },
    text: '',
    repository,
    filters,
    preserve: true,
  },
  'focus-log': { kind: 'focus-log' },
  history: {
    kind: 'history',
    page: {
      commits: [commit],
      refs: [reference],
      nextCursor: null,
      scopeId: 'head',
      annotations: {
        user: { name: 'John Smith', email: 'john.smith@example.test' },
        currentBranch: [sha],
      },
    },
    append: false,
    scope: { kind: 'all' },
    text: '',
    repository,
    filters,
    restoring: true,
  },
  'history-settled': { kind: 'history-settled' },
  'history-enrichment': {
    kind: 'history-enrichment',
    enrichment: {
      scopeId: 'head',
      shas: [sha],
      refs: [reference],
      annotations: { user: null, currentBranch: [sha] },
    },
  },
  'history-interrupted': { kind: 'history-interrupted' },
  'worktrees-loading': { kind: 'worktrees-loading', loading: true },
  'worktrees-error': { kind: 'worktrees-error', message: 'Unavailable' },
  details: { kind: 'details', commit },
  files: {
    kind: 'files',
    sha,
    parentSha: null,
    files: [
      { id: 'file', status: 'added', oldPath: null, newPath: 'index.ts' },
    ],
  },
  'files-error': {
    kind: 'files-error',
    sha,
    parentSha: null,
    message: 'Read failed',
  },
  worktrees: {
    kind: 'worktrees',
    worktrees: [
      {
        id: 'tree',
        name: 'Example',
        rootUri: 'file:///example',
        branch: null,
        current: true,
        available: true,
        main: true,
        locked: false,
        deletionBlocked: 'Main worktree',
      },
    ],
  },
  operation: {
    kind: 'operation',
    result: {
      kind: 'success',
      backend: 'cli',
      replacementSha: sha,
      message: 'Updated',
      branchRestore: { name: 'feature', token: 'restore', names: ['feature'] },
    },
  },
  'operation-progress': {
    kind: 'operation-progress',
    operation: {
      label: 'Updating main…',
      refIds: ['refs/heads/main'],
      phase: 'running',
    },
  },
  error: { kind: 'error', message: 'Failed' },
  references: { kind: 'references', references: [reference] },
} satisfies { [Kind in PanelBody['kind']]: Extract<PanelBody, { kind: Kind }> };

function response(body: unknown) {
  return { requestId: 'read', repositoryId: 'repository', generation: 2, body };
}

const continuation: BranchUpdateContinuation = {
  target: {
    kind: 'update-branch',
    refId: 'refs/heads/main',
    expectedSha: sha,
    expectedUpstream: 'refs/remotes/origin/main',
  },
  checkout: { ref: 'refs/heads/main', sha },
  fetchedSha: sha,
  incomingCount: 1,
  remote: 'origin',
  remoteRef: 'refs/heads/main',
};

describe('host response parsing', () => {
  test.each(['checkout', 'integrate'] as const)(
    'accepts a captured Update %s decision',
    (kind) => {
      const message = response({
        kind: 'operation',
        result: {
          kind: 'error',
          backend: 'cli',
          message: 'Update stopped',
          updateDecision: { kind, continuation },
        },
      });

      expect(parsePanelResult(message)).toEqual(message);
    },
  );
  test.each([
    { ...continuation, target: { ...continuation.target, expectedSha: '' } },
    { ...continuation, checkout: { ref: 'main', sha } },
    { ...continuation, checkout: { ref: null, sha: '' } },
    { ...continuation, fetchedSha: '' },
    { ...continuation, remote: '' },
    { ...continuation, incomingCount: 0 },
    { ...continuation, incomingCount: 0.5 },
  ])('rejects incomplete Update recovery targets: %j', (continuation) => {
    expect(
      parsePanelResult(
        response({
          kind: 'operation',
          result: {
            kind: 'error',
            backend: 'cli',
            message: 'Update stopped',
            updateDecision: { kind: 'checkout', continuation },
          },
        }),
      ),
    ).toBeNull();
  });
  test.each(Object.values(bodies))(
    'accepts the complete $kind response',
    (body) => {
      expect(parsePanelResult(response(body))).toEqual(response(body));
    },
  );

  test.each([
    {
      kind: 'operation-progress',
      operation: {
        label: 'Updating main…',
        refIds: ['refs/heads/main'],
        phase: 'refreshing',
      },
    },
    { kind: 'operation-progress', operation: null },
    { kind: 'operation', result: { kind: 'cancelled', backend: null } },
    {
      kind: 'operation',
      result: {
        kind: 'conflict',
        backend: 'api',
        message: 'Resolve conflicts',
        recovery: 'source-control',
      },
    },
    {
      kind: 'operation',
      result: { kind: 'error', backend: 'command', message: 'Failed' },
    },
    { kind: 'file-icon-theme', theme: null, stylesheet: null },
    {
      kind: 'loading',
      scope: { kind: 'ref', refId: reference.id },
      text: '',
      repository,
    },
    { kind: 'loading', scope: { kind: 'commit', sha }, text: '', repository },
  ] satisfies PanelBody[])(
    'accepts nullable and alternate variants: %j',
    (body) => {
      expect(parsePanelResult(response(body))).toEqual(response(body));
    },
  );

  test.each([
    {
      kind: 'operation-progress',
      operation: {
        label: 'Updating',
        refIds: [],
        phase: 'running',
        section: 'other',
      },
    },
    {
      kind: 'operation-progress',
      operation: {
        label: 'Updating',
        refIds: [],
        phase: 'running',
        queued: [{ label: 'Waiting', refIds: [], section: {} }],
      },
    },
    {
      kind: 'operation-progress',
      operation: { label: '', refIds: [], phase: 'running' },
    },
    {
      kind: 'operation-progress',
      operation: {
        label: 'Updating',
        refIds: ['refs/heads/'],
        phase: 'running',
      },
    },
    {
      kind: 'operation-progress',
      operation: { label: 'Updating', refIds: [], phase: 'unknown' },
    },
    { kind: 'operation-progress', operation: undefined },
    { kind: 'notice', message: null },
    { kind: 'reveal', sha: 0 },
    { ...bodies.filters, filters: { ...filters, matchCase: 'yes' } },
    { ...bodies.selection, anchor: { sha, offset: 22 } },
    { ...bodies.setup, repositories: [{ ...repository, branch: undefined }] },
    { ...bodies.loading, scope: { kind: 'ref' } },
    { ...bodies.loading, preserve: 'yes' },
    {
      ...bodies.history,
      page: { ...bodies.history.page, commits: [{ ...commit, parents: [0] }] },
    },
    {
      ...bodies.history,
      page: {
        ...bodies.history.page,
        annotations: { user: {}, currentBranch: [] },
      },
    },
    { ...bodies.details, commit: { ...commit, commitDate: 0 } },
    {
      ...bodies.files,
      files: [
        { id: 'file', status: 'unknown', oldPath: null, newPath: 'file' },
      ],
    },
    { ...bodies['files-error'], parentSha: 0 },
    {
      ...bodies.worktrees,
      worktrees: [{ ...bodies.worktrees.worktrees[0], locked: 'yes' }],
    },
    {
      ...bodies.references,
      references: [
        {
          ...reference,
          tracking: { upstream: 'origin/main', ahead: 'one', behind: 0 },
        },
      ],
    },
    { kind: 'operation', result: { kind: 'conflict', backend: 'cli' } },
    {
      kind: 'operation',
      result: {
        kind: 'success',
        backend: 'cli',
        branchRestore: { name: 'feature' },
      },
    },
    { kind: 'operation', result: { kind: 'success', backend: 'other' } },
    {
      ...bodies['file-icon-theme'],
      theme: {
        ...bodies['file-icon-theme'].theme,
        definitions: { script: { className: 3 } },
      },
    },
    {
      ...bodies['file-icon-theme'],
      theme: {
        ...bodies['file-icon-theme'].theme,
        languages: {
          fileNames: {},
          extensions: {},
          patterns: [
            {
              source: '[',
              language: 'typescript',
              matchPath: false,
              configured: false,
            },
          ],
        },
      },
    },
    { kind: 'future-message' },
    { kind: '__proto__' },
  ])('rejects malformed nested response data: %j', (body) => {
    expect(parsePanelResult(response(body))).toBeNull();
  });

  test('accepts unknown fields on known messages for forward compatibility', () => {
    const value = response({
      kind: 'notice',
      message: 'Updated',
      futureField: true,
    });

    expect(parsePanelResult(value)?.body).toMatchObject({
      kind: 'notice',
      message: 'Updated',
    });
  });
});
