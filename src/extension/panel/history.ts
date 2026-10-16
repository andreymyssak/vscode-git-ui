import { normalizeHistoryFilters } from '../../shared/history-filters';
import type { PanelBody } from '../../shared/messages';
import type {
  HistoryEnrichment,
  HistoryInput,
  HistoryPage,
  RepositoryInfo,
} from '../../shared/model';
import type { GitAdapter } from '../git/adapter';
import type { LazyHistoryEnrichment } from '../git/history';
import type { QuerySession } from './queries';

interface HistoryPublication {
  repository(id: string): RepositoryInfo;
  send(
    body: PanelBody,
    requestId: string,
    id: string,
    generation: number,
  ): Promise<void>;
}

export interface PendingHistoryEnrichment {
  page: HistoryPage;
  read: LazyHistoryEnrichment;
}

/** Pins each asynchronous read to the query and generation that requested it. */
export class PanelHistory {
  constructor(
    private readonly adapter: GitAdapter,
    private readonly session: QuerySession,
    private readonly publication: HistoryPublication,
  ) {}

  async publish(
    page: HistoryPage,
    query: HistoryInput,
    requestId: string,
    append: boolean,
    restoring = false,
    enrichments: readonly PendingHistoryEnrichment[] = [],
  ): Promise<void> {
    const id = this.session.repositoryId;
    const generation = this.session.generation;
    const signal = this.session.abort.signal;
    const repository = this.publication.repository(id);

    this.session.repositoryInfo = repository;
    this.session.recordHistory(query, page, append);
    await this.publication.send(
      {
        kind: 'history',
        page,
        append,
        scope: query.scope,
        text: query.text,
        repository,
        filters: normalizeHistoryFilters(query.filters),
        restoring,
      },
      requestId,
      id,
      generation,
    );
    for (const pending of enrichments)
      this.enrich(pending, requestId, id, generation, signal);
  }

  private enrich(
    { page, read }: PendingHistoryEnrichment,
    requestId: string,
    id: string,
    generation: number,
    signal: AbortSignal,
  ): void {
    void Promise.resolve()
      .then(() => read(signal))
      .then(async (value) => {
        if (
          signal.aborted ||
          !this.session.current(id, generation) ||
          value.scopeId !== page.scopeId
        )
          return;
        const shas = new Set(page.commits.map((commit) => commit.sha));

        if (!value.shas.every((sha) => shas.has(sha))) return;
        this.session.refs.clear();
        for (const ref of value.refs) this.session.refs.set(ref.id, ref);
        this.session.enrichHistory(value);
        await this.publication.send(
          { kind: 'history-enrichment', enrichment: value },
          requestId,
          id,
          generation,
        );
      })
      .catch(() => {
        /* Optional metadata cannot fail a published page. */
      });
  }

  /** Restore the selected window with one row publication and lazy optional metadata. */
  async loadUntil(
    query: HistoryInput,
    requestId: string,
    targets: readonly string[],
    sourceCurrent: () => boolean,
  ): Promise<HistoryPage | null> {
    const id = this.session.repositoryId;
    const generation = this.session.generation;
    const signal = this.session.abort.signal;
    const current = () =>
      !signal.aborted &&
      this.session.current(id, generation) &&
      sourceCurrent();
    const commits: HistoryPage['commits'] = [];
    const seen = new Set<string>();
    const enrichments: PendingHistoryEnrichment[] = [];
    let cursor: string | null = null;
    let result: HistoryPage | null = null;

    try {
      do {
        if (!current()) return null;
        let read: LazyHistoryEnrichment | null = null;
        const next = await this.adapter.history(
          id,
          { ...query, cursor },
          signal,
          async (references) => {
            if (!current()) return;
            const repository = this.publication.repository(id);

            this.session.repositoryInfo = repository;
            this.session.refs.clear();
            for (const ref of references) this.session.refs.set(ref.id, ref);
            await this.publication.send(
              { kind: 'references', references, repository },
              requestId,
              id,
              generation,
            );
          },
          undefined,
          {
            kind: 'lazy-enrichment',
            receive: (value) => {
              read = value;
            },
          },
        );

        if (!current()) return null;
        if (result && result.scopeId !== next.scopeId)
          throw new Error('History changed. Refresh to load a new snapshot.');
        for (const commit of next.commits) {
          if (seen.has(commit.sha)) continue;
          seen.add(commit.sha);
          commits.push(commit);
        }

        if (read) enrichments.push({ page: next, read });
        result = { ...next, commits };
        cursor = next.nextCursor;
      } while (cursor && targets.some((sha) => !seen.has(sha)));
    } catch (error) {
      if (!current()) return null;
      // Keep the successfully read prefix and its retry cursor on a later-page failure.
      if (result)
        await this.publish(result, query, requestId, false, true, enrichments);
      throw error;
    }

    if (!current() || !result) return null;
    await this.publish(result, query, requestId, false, true, enrichments);

    return current() ? result : null;
  }

  async start(
    query: HistoryInput,
    requestId: string,
    preserve: boolean,
  ): Promise<void> {
    const id = this.session.repositoryId;

    await this.publication.send(
      {
        kind: 'loading',
        preserve,
        scope: query.scope,
        text: query.text,
        repository: this.publication.repository(id),
        filters: normalizeHistoryFilters(query.filters),
      },
      requestId,
      id,
      this.session.generation,
    );
  }

  async load(
    query: HistoryInput,
    requestId: string,
    cursor: string | null,
    preserve = false,
    sourceCurrent = () => true,
  ): Promise<HistoryPage | null> {
    if (!sourceCurrent()) return null;
    const id = this.session.repositoryId;
    const generation = this.session.generation;
    const signal = this.session.abort.signal;
    const input = {
      ...query,
      scope: { ...query.scope },
      filters: normalizeHistoryFilters(query.filters),
      cursor,
    };
    const current = () =>
      this.session.current(id, generation) && sourceCurrent();

    // Restoring callers publish activity before checking their reference.
    if (!cursor && !preserve) await this.start(input, requestId, false);
    if (!current()) return null;
    let page: HistoryPage;
    const enrichment: { pending: Promise<HistoryEnrichment | null> | null } = {
      pending: null,
    };

    try {
      page = await this.adapter.history(
        id,
        input,
        signal,
        async (references) => {
          if (!current()) return;
          const repository = this.publication.repository(id);

          this.session.repositoryInfo = repository;
          this.session.refs.clear();
          for (const ref of references) this.session.refs.set(ref.id, ref);
          await this.publication.send(
            { kind: 'references', references, repository },
            requestId,
            id,
            generation,
          );
        },
        (pending) => {
          enrichment.pending = pending.catch(() => null);
        },
      );
    } catch (error) {
      if (!current()) return null;
      throw error;
    }

    if (!current()) return null;
    await this.publish(page, input, requestId, cursor !== null, preserve);
    if (enrichment.pending) {
      const pending = enrichment.pending;

      this.enrich(
        {
          page,
          read: async () => {
            const value = await pending;

            if (!value) throw new Error('History metadata is unavailable.');

            return value;
          },
        },
        requestId,
        id,
        generation,
        signal,
      );
    }

    return current() ? page : null;
  }
}
