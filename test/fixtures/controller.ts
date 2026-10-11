import type { GitAdapter } from '../../src/extension/git/adapter';
import type { ControllerOptions } from '../../src/extension/panel/controller';
import { PanelController } from '../../src/extension/panel/controller';
import type { PanelBody, RequestBody, Result } from '../../src/shared/messages';
import type { CommitRecord, HistoryPage } from '../../src/shared/model';

export const a = 'a'.repeat(40);
export const b = 'b'.repeat(40);
const commit = (sha: string): CommitRecord => ({
  sha,
  parents: [],
  message: sha,
  authorName: null,
  authorEmail: null,
  authorDate: null,
  commitDate: null,
});

export const page = (shas: string[]): HistoryPage => ({
  commits: shas.map(commit),
  refs: [
    {
      id: 'refs/heads/main',
      name: 'main',
      kind: 'local',
      sha: a,
      remote: null,
    },
  ],
  nextCursor: null,
  scopeId: 'fixture',
});
export function fixture(
  trusted = true,
  enabled = true,
  options: Partial<ControllerOptions> = {},
) {
  const sent: Result<PanelBody>[] = [];
  const writes: unknown[] = [];
  const editors: unknown[] = [];
  let repositoryEvent = () => {};

  let historyEvent = () => {};

  const adapter: GitAdapter = {
    invalidateHistory: () => {},
    authors: async () => [],
    prepareSquash: async () => {
      throw new Error('Squash is not configured in this fixture.');
    },
    prepareMessageEdit: async () => {},
    prepareDrop: async () => {
      throw new Error('Drop preparation is not configured in this fixture.');
    },
    repositories: () =>
      ['one', 'two'].map((id) => ({
        id,
        label: id,
        rootUri: `file:///fixture/${id}`,
        headSha: a,
        branch: 'main',
      })),
    references: async () => page([]).refs,
    history: async () => page([a, b]),
    resolve: async () => ({ kind: 'missing', message: 'Missing' }),
    blame: async () => {
      throw new Error('Unexpected blame read.');
    },
    changes: async (id, sha) => [
      {
        id: `${id}-${sha}`,
        status: 'modified',
        oldPath: 'safe.txt',
        newPath: 'safe.txt',
      },
    ],
    worktrees: async () => [],
    operate: async (id, action) => {
      writes.push({ id, action });

      return { kind: 'success', backend: 'api' };
    },
    subscribe: (_id, changed) => {
      historyEvent = changed;

      return {
        dispose() {
          if (historyEvent === changed) historyEvent = () => {};
        },
      };
    },
    subscribeRepositories: (changed) => {
      repositoryEvent = changed;

      return { dispose() {} };
    },
    dispose() {},
  };
  const controller = new PanelController({
    adapter: enabled ? adapter : null,
    trusted: () => trusted,
    send: (message) => {
      sent.push(message);
    },
    openChange: async (id, fileId, preview) => {
      editors.push({ id, fileId, preview });
    },
    pickRepository: async () => null,
    initialRepositoryId: null,
    ...options,
  });
  const request = (
    body: RequestBody,
    repositoryId = 'one',
    generation = 1,
  ) => ({ requestId: 'test', repositoryId, generation, body });

  return {
    controller,
    adapter,
    sent,
    writes,
    editors,
    request,
    fireRepositoryEvent: () => repositoryEvent(),
    fireHistoryEvent: () => historyEvent(),
  };
}
