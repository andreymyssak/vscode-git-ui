import { normalizeHistoryFilters } from '../../shared/history-filters';
import type { PanelBody } from '../../shared/messages';
import type {
  HistoryInput,
  HistoryPage,
  RepositoryInfo,
} from '../../shared/model';
import type { GitAdapter } from '../git/adapter';
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
  ): Promise<void> {
    const id = this.session.repositoryId;
    const generation = this.session.generation;
    const repository = this.publication.repository(id);

    this.session.repositoryInfo = repository;
    this.session.historyShas = [
      ...new Set([
        ...(append ? this.session.historyShas : []),
        ...page.commits.map((commit) => commit.sha),
      ]),
    ];
    this.session.refs.clear();
    for (const ref of page.refs) this.session.refs.set(ref.id, ref);
    for (const commit of page.commits)
      this.session.commits.set(commit.sha, commit);
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
      );
    } catch (error) {
      if (!current()) return null;
      throw error;
    }

    if (!current()) return null;
    await this.publish(page, input, requestId, cursor !== null, preserve);

    return current() ? page : null;
  }
}
