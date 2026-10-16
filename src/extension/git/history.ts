import { createHash, randomUUID } from 'node:crypto';

import { normalizeHistoryFilters } from '../../shared/history-filters';
import type {
  AuthorIdentity,
  CommitRecord,
  HistoryEnrichment,
  HistoryInput,
  HistoryPage,
  Reference,
} from '../../shared/model';
import { classifySearch } from '../../shared/search';
import type { GitApiAccess } from './api';
import { readBranchTracking } from './branch-tracking';
import type { GitCli } from './cli';
import { createHistoryAnnotations } from './history-annotations';
import { HistoryPageCache } from './history-cache';
import type { PreparedHistoryFilter } from './history-filter-page';
import {
  prepareHistoryFilter,
  readFilteredHistoryPage,
} from './history-filter-page';
import { readAuthors } from './history-filters';
import { createHistoryShallow, type HistoryShallow } from './history-shallow';
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
  filter: PreparedHistoryFilter | null;
  cacheKey: string;
  revision: symbol;
  reusable: boolean;
  head: string | null;
  tracking: Promise<Reference[]> | null;
  annotationOwner: symbol;
  shallow: string | null;
}

interface Cursor {
  snapshot: Snapshot;
  offset: number;
}

export type LazyHistoryEnrichment = (
  signal?: AbortSignal,
) => Promise<HistoryEnrichment>;
export interface HistoryReadOptions {
  kind: 'lazy-enrichment';
  receive(read: LazyHistoryEnrichment): void;
}

export interface HistoryQueries {
  authors(id: string, signal?: AbortSignal): Promise<AuthorIdentity[]>;
  page(
    id: string,
    input: HistoryInput,
    signal?: AbortSignal,
    onReferences?: (references: Reference[]) => Promise<void>,
    onEnrichment?: (pending: Promise<HistoryEnrichment>) => void,
    options?: HistoryReadOptions,
  ): Promise<HistoryPage>;
  invalidate(id: string): void;
  dispose(): void;
}
export function createHistoryQueries(
  access: GitApiAccess,
  reader: GitCli,
  clock: () => number = Date.now,
  shallow: HistoryShallow = createHistoryShallow(access, reader),
): HistoryQueries {
  const cursors = new Map<string, Cursor>();
  const cache = new HistoryPageCache<Snapshot>(clock);
  const annotations = createHistoryAnnotations(reader);
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
      annotations.invalidate(id);
      shallow.invalidate(id);
      cache.invalidate(id);
      for (const [token, cursor] of cursors)
        if (cursor.snapshot.repositoryId === id) cursors.delete(token);
    },
    dispose() {
      annotations.dispose();
      shallow.dispose();
      cursors.clear();
      for (const id of revisions.keys()) cache.invalidate(id);
      revisions.clear();
    },
    async page(id, input, signal, onReferences, onEnrichment, options) {
      const cli = reader.readOnly(signal);

      signal?.throwIfAborted();
      const started = revision(id);
      const shallowIdentity = await shallow.identity(id, signal);
      const filters = normalizeHistoryFilters(input.filters);
      const key = JSON.stringify({
        scope: input.scope,
        text: input.text,
        filters,
      });
      let snapshot: Snapshot;
      let offset = 0;
      let cachedCommits: CommitRecord[] | undefined;
      let nextOffset: number | null;

      if (input.cursor) {
        const cursor = cursors.get(input.cursor);

        if (
          !cursor ||
          cursor.snapshot.repositoryId !== id ||
          cursor.snapshot.key !== key ||
          shallowIdentity === null ||
          cursor.snapshot.shallow !== shallowIdentity
        )
          throw new Error('History changed. Refresh to load a new snapshot.');
        snapshot = cursor.snapshot;
        offset = cursor.offset;
        const cached = cache.read(id, snapshot.cacheKey, offset);

        cachedCommits = cached?.commits;
        nextOffset = cached?.nextOffset ?? null;
      } else {
        const refs = await readReferences(
          access,
          id,
          onEnrichment || options ? undefined : cli,
        );

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
          shallow: shallowIdentity,
        });
        // Me can change with Git configuration; rolling dates need a fresh cutoff.
        const reusable =
          shallowIdentity !== null &&
          filters.author.kind !== 'me' &&
          (filters.date === 'all' || typeof filters.date === 'object');
        const cached = reusable ? cache.read(id, cacheKey, 0) : undefined;

        snapshot = {
          repositoryId: id,
          key,
          tips,
          refs,
          scopeId: createHash('sha256')
            .update(
              JSON.stringify({
                tips: [...tips].sort(),
                text: input.text,
                filters,
                shallow: shallowIdentity,
              }),
            )
            .digest('hex'),
          filter: cached?.snapshot.filter ?? null,
          cacheKey,
          revision: started,
          reusable,
          head: repo.state.HEAD?.name ? head : null,
          tracking: null,
          annotationOwner: Symbol(),
          shallow: shallowIdentity,
        };
        cachedCommits = cached?.commits;
        nextOffset = cached?.nextOffset ?? null;
        if (
          !cached &&
          (filters.regex ||
            filters.matchCase ||
            filters.author.kind !== 'all' ||
            filters.date !== 'all' ||
            classifySearch(input.text) === 'hash-and-text' ||
            tips.reduce((size, tip) => size + tip.length + 1, 0) > 16384)
        )
          snapshot.filter = await prepareHistoryFilter(
            cli,
            id,
            {
              tips,
              text: input.text,
              filters,
              now: clock(),
            },
            signal,
          );
      }

      let commits: CommitRecord[];

      if (cachedCommits) commits = cachedCommits;
      else if (!snapshot.tips.length) commits = [];
      else if (snapshot.filter) {
        const filtered = await readFilteredHistoryPage(
          cli,
          id,
          snapshot.filter,
          offset,
          signal,
        );

        commits = filtered.commits;
        nextOffset = filtered.nextOffset;
      } else
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
      const enrich = async (owner = signal): Promise<HistoryEnrichment> => {
        const metadata = reader.readOnly(owner);

        snapshot.tracking ??=
          onEnrichment || options
            ? readBranchTracking(metadata, id)
                .then((tracking) => {
                  owner?.throwIfAborted();
                  if (started !== revision(id))
                    throw new Error(
                      'History changed. Refresh to load a new snapshot.',
                    );
                  snapshot.refs = snapshot.refs.map((ref) => ({
                    ...ref,
                    ...(ref.kind === 'local' &&
                    tracking.get(ref.id)?.sha === ref.sha
                      ? { tracking: tracking.get(ref.id)!.tracking }
                      : {}),
                  }));

                  return snapshot.refs;
                })
                .catch(() => snapshot.refs)
            : Promise.resolve(snapshot.refs);
        const membership = async () => {
          try {
            const found = await annotations.read({
              snapshot: snapshot.annotationOwner,
              repositoryId: id,
              head: snapshot.head,
              tips: snapshot.tips,
              commits,
              ...(owner ? { signal: owner } : {}),
            });

            owner?.throwIfAborted();

            return found;
          } catch {
            return [];
          }
        };

        const [user, currentBranch, refs] = await Promise.all([
          readUserIdentity(metadata, id, owner).catch(() => null),
          membership(),
          snapshot.tracking,
        ]);

        owner?.throwIfAborted();
        if (started !== revision(id))
          throw new Error('History changed. Refresh to load a new snapshot.');

        return {
          scopeId: snapshot.scopeId,
          shas: commits.map((commit) => commit.sha),
          refs: refs.map((ref) => ({
            ...ref,
            ...(ref.tracking ? { tracking: { ...ref.tracking } } : {}),
          })),
          annotations: { user, currentBranch: [...currentBranch] },
        };
      };

      let pageAnnotations: HistoryEnrichment['annotations'] = {
        user: null,
        currentBranch:
          snapshot.head &&
          snapshot.tips.length === 1 &&
          snapshot.tips[0] === snapshot.head
            ? commits.map((commit) => commit.sha)
            : [],
      };
      let references = snapshot.refs;

      if (options) options.receive(enrich);
      else if (onEnrichment) onEnrichment(enrich());
      else {
        const enriched = await enrich();

        pageAnnotations = enriched.annotations;
        references = enriched.refs;
      }

      signal?.throwIfAborted();
      if (started !== revision(id) || snapshot.revision !== started)
        throw new Error('History changed. Refresh to load a new snapshot.');
      if (!snapshot.filter)
        nextOffset = commits.length === 200 ? offset + commits.length : null;
      if (!cachedCommits && snapshot.reusable)
        cache.write(
          id,
          snapshot.cacheKey,
          offset,
          snapshot,
          commits,
          nextOffset,
        );
      let nextCursor: string | null = null;

      if (nextOffset !== null) {
        nextCursor = randomUUID();
        cursors.set(nextCursor, { snapshot, offset: nextOffset });
        if (cursors.size > 100) {
          const oldest = cursors.keys().next().value;

          if (oldest) cursors.delete(oldest);
        }
      }

      return {
        commits,
        refs: references.map((ref) => ({
          ...ref,
          ...(ref.tracking ? { tracking: { ...ref.tracking } } : {}),
        })),
        nextCursor,
        scopeId: snapshot.scopeId,
        annotations: pageAnnotations,
      };
    },
  };
}
