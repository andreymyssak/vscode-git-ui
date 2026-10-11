import { describe, expect, it } from 'vitest';

import type {
  SourceControlRequest,
  SourceControlResponse,
} from '../../src/shared/source-control';
import {
  parseSourceControlRequest,
  parseSourceControlResponse,
} from '../../src/shared/source-control-protocol';

describe('source-control boundary', () => {
  const sha = 'a'.repeat(40);
  const requests: SourceControlRequest[] = [
    { kind: 'ready', repositoryId: null, tab: 'stash' },
    { kind: 'refresh' },
    { kind: 'tab', tab: 'commit' },
    { kind: 'repository', repositoryId: 'file:///repo' },
    {
      kind: 'check',
      repositoryId: 'file:///repo',
      paths: ['src/a file.ts'],
      checked: true,
    },
    {
      kind: 'message',
      repositoryId: 'file:///repo',
      message: 'A subject\n\nA body',
      editId: 'session:1',
    },
    { kind: 'commit', repositoryId: 'file:///repo' },
    { kind: 'stash', repositoryId: 'file:///repo' },
    { kind: 'stash-silently', repositoryId: 'file:///repo' },
    { kind: 'reveal-working', repositoryId: 'file:///repo' },
    { kind: 'generate', repositoryId: 'file:///repo' },
    { kind: 'amend', repositoryId: 'file:///repo', enabled: true },
    { kind: 'cancel-generation' },
    { kind: 'commit-selected', repositoryId: 'repo', paths: ['a.ts', 'b.ts'] },
    { kind: 'stash-selected', repositoryId: 'repo', paths: ['a.ts'] },
    { kind: 'open-files', repositoryId: 'repo', paths: ['a.ts'] },
    { kind: 'copy-paths', repositoryId: 'repo', paths: ['src'] },
    { kind: 'rollback', repositoryId: 'repo', paths: ['a.ts'] },
    {
      kind: 'open-stash-files',
      repositoryId: 'repo',
      sha,
      files: [{ path: 'a.ts', snapshot: 'index' }],
    },
    {
      kind: 'open-working-files',
      repositoryId: 'repo',
      paths: ['a.ts'],
      index: true,
    },
    { kind: 'discard-working', repositoryId: 'file:///repo', path: 'a.ts' },
    { kind: 'open-file', repositoryId: 'file:///repo', path: 'a.ts' },
    {
      kind: 'open-working',
      repositoryId: 'file:///repo',
      path: 'a.ts',
      index: false,
    },
    { kind: 'load-stash', repositoryId: 'file:///repo', sha },
    { kind: 'restore-stash', repositoryId: 'file:///repo', sha },
    { kind: 'delete-stash', repositoryId: 'file:///repo', sha },
    { kind: 'rename-stash', repositoryId: 'file:///repo', sha },
    {
      kind: 'delete-stash-files',
      repositoryId: 'file:///repo',
      sha,
      files: [{ path: 'a.ts', snapshot: 'working' }],
    },
    {
      kind: 'open-stash-file',
      repositoryId: 'file:///repo',
      sha,
      file: { path: 'a.ts', snapshot: 'working' },
    },
    {
      kind: 'restore-stash-files',
      repositoryId: 'file:///repo',
      sha,
      files: [{ path: 'new.ts', snapshot: 'untracked' }],
    },
  ];

  it.each(requests)('accepts the supported $kind request', (request) => {
    expect(parseSourceControlRequest(request)).toEqual(request);
  });

  it.each(['../private', '/private', '.git/config', 'a/../b', 'a\0b', 'a/./b'])(
    'rejects unsafe file targets %s',
    (path) => {
      for (const kind of ['discard-working', 'open-file'])
        expect(
          parseSourceControlRequest({ kind, repositoryId: 'repo', path }),
        ).toBeNull();
      expect(
        parseSourceControlRequest({
          kind: 'check',
          repositoryId: 'repo',
          paths: [path],
          checked: true,
        }),
      ).toBeNull();
      expect(
        parseSourceControlRequest({
          kind: 'open-stash-file',
          repositoryId: 'repo',
          sha,
          file: { path, snapshot: 'working' },
        }),
      ).toBeNull();
    },
  );

  it.each([
    { kind: 'commit' },
    { kind: 'amend', repositoryId: 'repo' },
    { kind: 'amend', repositoryId: 'repo', enabled: 'yes' },
    { kind: 'rollback', repositoryId: 'repo', paths: [] },
    { kind: 'rollback', repositoryId: 'repo', paths: ['../other'] },
    { kind: 'commit-selected', repositoryId: 'repo', paths: [] },
    { kind: 'stash-selected', repositoryId: 'repo', paths: ['../other'] },
    { kind: 'open-files', repositoryId: 'repo', paths: ['.git/config'] },
    { kind: 'copy-paths', repositoryId: 'repo', paths: ['/outside'] },
    { kind: 'open-working-files', repositoryId: 'repo', paths: ['a.ts'] },
    { kind: 'tab', tab: 'log' },
    { kind: 'delete-stash', repositoryId: 'repo', sha: 'stash@{0}' },
    { kind: 'check', repositoryId: 'repo', paths: ['a'], checked: 1 },
    {
      kind: 'message',
      repositoryId: 'repo',
      message: 'x'.repeat(65_537),
      editId: 'session:1',
    },
    { kind: 'message', repositoryId: 'repo', message: 'Draft' },
    { kind: 'message', repositoryId: 'repo', message: 'Draft', editId: '' },
    {
      kind: 'restore-stash-files',
      repositoryId: 'repo',
      sha,
      files: [{ path: 'a', snapshot: 'invalid' }],
    },
  ])('rejects malformed requests', (request) => {
    expect(parseSourceControlRequest(request)).toBeNull();
  });

  it.each([
    'a.ts',
    'a:notes.txt',
    String.raw`two\\slashes.txt`,
    String.raw`C:\private`,
  ])(
    'accepts repository-relative Git filename %s in requests and state',
    (path) => {
      expect(
        parseSourceControlRequest({
          kind: 'check',
          repositoryId: 'repo',
          paths: [path],
          checked: true,
        }),
      ).toEqual({
        kind: 'check',
        repositoryId: 'repo',
        paths: [path],
        checked: true,
      });
      const response: SourceControlResponse = {
        kind: 'source-control-state',
        state: {
          hoverDelay: 500,
          repositoryId: 'repo',
          tab: 'commit',
          busy: false,
          generating: false,
          reveal: null,
          repositories: [
            {
              pathLabel: { root: '/repo', separator: '/' },
              info: {
                id: 'repo',
                label: 'Repo',
                rootUri: 'file:///repo',
                headSha: sha,
                branch: 'main',
              },
              draft: '',
              draftEditId: null,
              commitMode: { kind: 'new' },
              checked: [path],
              changes: {
                kind: 'ready',
                items: [
                  {
                    path,
                    originalPath: path,
                    status: ' M',
                    staged: false,
                    working: true,
                    untracked: false,
                  },
                ],
              },
              stashes: {
                kind: 'ready',
                items: [
                  {
                    sha,
                    selector: 'stash@{0}',
                    message: 'A stash',
                    date: '2026-10-10T00:00:00Z',
                    base: sha,
                    files: { kind: 'loading' },
                  },
                ],
              },
            },
          ],
        },
      };

      expect(parseSourceControlResponse(response)).toEqual(response);
      expect(
        parseSourceControlResponse({
          ...response,
          state: {
            ...response.state,
            reveal: { repositoryId: 'repo', path, sequence: 1 },
          },
        }),
      ).toMatchObject({ state: { reveal: { path, sequence: 1 } } });
      expect(
        parseSourceControlResponse({
          ...response,
          state: {
            ...response.state,
            reveal: { repositoryId: 'repo', path: '../private', sequence: 1 },
          },
        }),
      ).toBeNull();
      expect(
        parseSourceControlResponse({
          ...response,
          state: {
            ...response.state,
            reveal: { repositoryId: 'repo', path, sequence: -1 },
          },
        }),
      ).toBeNull();
      expect(
        parseSourceControlResponse({
          ...response,
          state: {
            ...response.state,
            repositories: [
              {
                ...response.state.repositories[0],
                changes: { kind: 'ready', items: [{ path: '../a' }] },
              },
            ],
          },
        }),
      ).toBeNull();
      expect(
        parseSourceControlResponse({ kind: 'source-control-state', state: {} }),
      ).toBeNull();
    },
  );
});
