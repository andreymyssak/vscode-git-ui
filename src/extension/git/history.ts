import { randomUUID } from 'node:crypto';

import { normalizeHistoryFilters } from '../../shared/history-filters';
import type {
  AuthorIdentity,
  CommitRecord,
  HistoryInput,
  HistoryPage,
  Reference,
} from '../../shared/model';
import { classifySearch } from '../../shared/search';
import type { GitApiAccess } from './api';
import type { GitCli } from './cli';
import { currentBranchCommits } from './history-annotations';
import { HistoryPageCache } from './history-cache';
import { filteredHistoryOrder, readAuthors } from './history-filters';
import { readUserIdentity } from './identity';
import { commitRecord, readReferences } from './resolve';

export { classifySearch } from '../../shared/search';
export function escapeLiteral(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

interface Snapshot {
  repositoryId: string;
  key: string;
  tips: string[];
  refs: Reference[];
  scopeId: string;
  hashOrder: string[] | null;
  cacheKey: string;
  revision: symbol;
  reusable: boolean;
  head: string | null;
  memberships: Map<number, string[]>;
}

interface Cursor {
  snapshot: Snapshot;
  offset: number;
}

export interface HistoryQueries {
  authors(id: string, signal?: AbortSignal): Promise<AuthorIdentity[]>;
  page(
    id: string,
    input: HistoryInput,
    signal?: AbortSignal,
    onReferences?: (references: Reference[]) => Promise<void>,
  ): Promise<HistoryPage>;
  invalidate(id: string): void;
}
export function createHistoryQueries(
  access: GitApiAccess,
  reader: GitCli,
  clock: () => number = Date.now,
): HistoryQueries {
  const cursors = new Map<string, Cursor>();
  const cache = new HistoryPageCache<Snapshot>(clock);
  const revisions = new Map<string, symbol>();
  const revision = (id: string) => {
    if (!revisions.has(id)) revisions.set(id, Symbol());

    return revisions.get(id)!;
  };

  return {
    async authors(id, signal) {
      const cli = reader.readOnly(signal);
      const refs = await readReferences(access, id, cli);
      const repo = access.repository(id);
      let head: string | null = null;

      try {
        head = (await repo.getCommit('HEAD')).hash;
      } catch (error) {
        if (refs.length || repo.state.HEAD?.commit) throw error;
      }

      return readAuthors(
        cli,
        id,
        [...new Set([...refs.map((ref) => ref.sha), ...(head ? [head] : [])])],
        signal,
      );
    },
    invalidate(id) {
      revisions.set(id, Symbol());
      cache.invalidate(id);
      for (const [token, cursor] of cursors)
        if (cursor.snapshot.repositoryId === id) cursors.delete(token);
    },
    async page(id, input, signal, onReferences) {
      const cli = reader.readOnly(signal);

      signal?.throwIfAborted();
      const started = revision(id);
      const filters = normalizeHistoryFilters(input.filters);
      const key = JSON.stringify({
        scope: input.scope,
        text: input.text,
        filters,
      });
      let snapshot: Snapshot;
      let offset = 0;
      let cachedCommits: CommitRecord[] | undefined;

      if (input.cursor) {
        const cursor = cursors.get(input.cursor);

        if (
          !cursor ||
          cursor.snapshot.repositoryId !== id ||
          cursor.snapshot.key !== key
        )
          throw new Error('History changed. Refresh to load a new snapshot.');
        snapshot = cursor.snapshot;
        offset = cursor.offset;
        cachedCommits = cache.read(id, snapshot.cacheKey, offset)?.commits;
      } else {
        const refs = await readReferences(access, id, cli);

        signal?.throwIfAborted();
        await onReferences?.(refs);
        signal?.throwIfAborted();
        const repo = access.repository(id);
        let head: string | null = null;

        try {
          head = (await repo.getCommit('HEAD')).hash;
        } catch (error) {
          if (refs.length || repo.state.HEAD?.commit) throw error;
        }

        const all =
          (!filters.regex && classifySearch(input.text) === 'hash-and-text') ||
          input.scope.kind === 'all';
        let tips: string[];

        if (all)
          tips = [
            ...new Set([
              ...refs.map((ref) => ref.sha),
              ...(head ? [head] : []),
            ]),
          ];
        else if (input.scope.kind === 'head') tips = head ? [head] : [];
        else if (input.scope.kind === 'commit') {
          if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(input.scope.sha))
            throw new Error('Invalid commit identity.');
          tips = [(await repo.getCommit(input.scope.sha)).hash];
        } else if (input.scope.kind === 'ref') {
          const refId = input.scope.refId;
          const ref = refs.find((ref) => ref.id === refId);

          if (!ref)
            throw new Error(
              'Selected reference no longer exists. Return to HEAD.',
            );
          tips = [(await repo.getCommit(ref.sha)).hash];
        } else tips = [];
        const cacheKey = JSON.stringify({
          key,
          head,
          refs,
          branch: repo.state.HEAD?.name ?? null,
        });
        // Me can change with Git configuration; rolling dates need a fresh cutoff.
        const reusable =
          filters.author.kind !== 'me' &&
          (filters.date === 'all' || typeof filters.date === 'object');
        const cached = reusable ? cache.read(id, cacheKey, 0) : undefined;

        snapshot = cached?.snapshot ?? {
          repositoryId: id,
          key,
          tips,
          refs,
          scopeId: JSON.stringify({
            tips: [...tips].sort(),
            text: input.text,
            filters,
          }),
          hashOrder: null,
          cacheKey,
          revision: started,
          reusable,
          head: repo.state.HEAD?.name ? head : null,
          memberships: new Map(),
        };
        cachedCommits = cached?.commits;
        if (
          !cached &&
          (filters.regex ||
            filters.matchCase ||
            filters.author.kind !== 'all' ||
            filters.date !== 'all' ||
            classifySearch(input.text) === 'hash-and-text')
        )
          snapshot.hashOrder = await filteredHistoryOrder(
            cli,
            id,
            tips,
            input.text,
            filters,
            clock(),
            signal,
          );
      }

      let commits: CommitRecord[];

      if (cachedCommits) commits = cachedCommits;
      else if (!snapshot.tips.length) commits = [];
      else if (snapshot.hashOrder)
        commits = await Promise.all(
          snapshot.hashOrder
            .slice(offset, offset + 200)
            .map(async (sha) =>
              commitRecord(
                await access.repository(id).getCommit(sha),
                cli,
                id,
                signal,
              ),
            ),
        );
      else
        commits = await Promise.all(
          (
            await access.repository(id).log({
              refNames: snapshot.tips,
              maxEntries: 200,
              skip: offset,
              ...(input.text ? { grep: escapeLiteral(input.text) } : {}),
            })
          ).map((commit) => commitRecord(commit, cli, id, signal)),
        );
      const user = await readUserIdentity(cli, id, signal).catch(() => null);
      let currentBranch = snapshot.memberships.get(offset);

      if (!currentBranch) {
        try {
          currentBranch = await currentBranchCommits(
            cli,
            id,
            snapshot.head,
            snapshot.tips,
            commits,
            signal,
          );
          signal?.throwIfAborted();
          snapshot.memberships.set(offset, currentBranch);
          if (snapshot.memberships.size > 20)
            snapshot.memberships.delete(
              snapshot.memberships.keys().next().value!,
            );
        } catch {
          // An unavailable optional annotation must not hide otherwise valid history.
          currentBranch = [];
        }
      }

      signal?.throwIfAborted();
      if (started !== revision(id) || snapshot.revision !== started)
        throw new Error('History changed. Refresh to load a new snapshot.');
      // Large filter identity scans stay cursor-owned instead of accumulating here.
      if (
        !cachedCommits &&
        snapshot.reusable &&
        (snapshot.hashOrder?.length ?? 0) <= 20_000
      )
        cache.write(id, snapshot.cacheKey, offset, snapshot, commits);
      let nextCursor: string | null = null;
      const hasMore = snapshot.hashOrder
        ? offset + commits.length < snapshot.hashOrder.length
        : commits.length === 200;

      if (hasMore) {
        nextCursor = randomUUID();
        cursors.set(nextCursor, { snapshot, offset: offset + commits.length });
        if (cursors.size > 100) {
          const oldest = cursors.keys().next().value;

          if (oldest) cursors.delete(oldest);
        }
      }

      return {
        commits,
        refs: snapshot.refs.map((ref) => ({
          ...ref,
          ...(ref.tracking ? { tracking: { ...ref.tracking } } : {}),
        })),
        nextCursor,
        scopeId: snapshot.scopeId,
        annotations: { user, currentBranch: [...currentBranch] },
      };
    },
  };
}
