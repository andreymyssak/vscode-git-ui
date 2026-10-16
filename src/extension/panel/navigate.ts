import type {
  CommitRecord,
  HistoryInput,
  HistoryPage,
  Reference,
} from '../../shared/model';
import type { GitAdapter } from '../git/adapter';
import type { LazyHistoryEnrichment } from '../git/history';
import type { PendingHistoryEnrichment } from './history';
import type { NavigationDecision } from './navigation';
import { planNavigation } from './navigation';
import type { QuerySession } from './queries';

export interface NavigationPrompts {
  pickReference?: (references: Reference[]) => Promise<string | null>;
  offerNavigation?: (decision: NavigationDecision) => Promise<boolean>;
}

interface NavigationResult {
  commit: CommitRecord;
  page: HistoryPage | null;
  input: HistoryInput;
  replace: boolean;
  enrichments: PendingHistoryEnrichment[];
}

/** Finds a revision without changing the active query until the user accepts it. */
export class PanelNavigator {
  private navigationSequence = 0;

  constructor(
    private readonly adapter: GitAdapter,
    private readonly session: QuerySession,
    private readonly prompts: NavigationPrompts,
  ) {}

  cancel(): void {
    this.navigationSequence++;
  }

  async navigate(
    id: string,
    input: string,
    query: HistoryInput,
    apply: (result: NavigationResult, isLatest: () => boolean) => Promise<void>,
    options: { confirmScopeChange: boolean; isCurrent?: () => boolean } = {
      confirmScopeChange: true,
    },
  ): Promise<void> {
    const generation = this.session.generation;
    const sequence = ++this.navigationSequence;
    const isLatest = () =>
      sequence === this.navigationSequence && (options.isCurrent?.() ?? true);
    const current = () => this.session.current(id, generation) && isLatest();

    try {
      let target = await this.adapter.resolve(
        id,
        input,
        this.session.abort.signal,
      );

      if (!current()) return;
      if (target.kind === 'choices') {
        const ref = await this.prompts.pickReference?.(target.references);

        if (!ref || !current()) return;
        target = await this.adapter.resolve(id, ref, this.session.abort.signal);
      }

      if (!current()) return;

      if (target.kind !== 'commit') {
        if (target.kind === 'missing' || target.kind === 'ambiguous')
          throw new Error(target.message);

        return;
      }

      const commit = target.commit;
      const signal = this.session.abort.signal;
      const scan = async (
        input: HistoryInput,
      ): Promise<{
        page: HistoryPage;
        enrichments: PendingHistoryEnrichment[];
      } | null> => {
        const prefix = this.session.historyPrefix(input);
        const commits: HistoryPage['commits'] = [...(prefix?.commits ?? [])];
        const seen = new Set(commits.map((item) => item.sha));
        const enrichments: PendingHistoryEnrichment[] = [];
        let cursor: string | null = prefix?.nextCursor ?? null;
        let scopeId = prefix?.scopeId;

        if (prefix && !prefix.nextCursor) return null;

        do {
          signal.throwIfAborted();
          this.session.abort.signal.throwIfAborted();
          if (!current()) return null;
          const pending: { read: LazyHistoryEnrichment | null } = {
            read: null,
          };
          const page = await this.adapter.history(
            id,
            { ...input, cursor },
            signal,
            undefined,
            undefined,
            {
              kind: 'lazy-enrichment',
              receive: (read) => {
                pending.read = read;
              },
            },
          );

          if (!current()) return null;
          if (scopeId !== undefined && scopeId !== page.scopeId)
            throw new Error('History changed. Refresh to load a new snapshot.');
          scopeId = page.scopeId;
          for (const item of page.commits) {
            if (seen.has(item.sha)) continue;
            seen.add(item.sha);
            commits.push(item);
          }

          if (pending.read) enrichments.push({ page, read: pending.read });
          if (page.commits.some((item) => item.sha === commit.sha))
            return {
              page: {
                ...page,
                commits,
                ...(prefix?.annotations
                  ? { annotations: prefix.annotations }
                  : {}),
              },
              enrichments,
            };
          cursor = page.nextCursor;
        } while (cursor);

        return null;
      };

      let result = this.session.commits.has(commit.sha)
        ? null
        : await scan(query);
      const inQuery = this.session.commits.has(commit.sha) || result !== null;
      const allPage = inQuery
        ? null
        : await scan({ scope: { kind: 'all' }, text: '', cursor: null });

      if (!current()) return;
      const decision = planNavigation(target, {
        inQuery,
        inAll: allPage !== null,
        scope: query.scope,
      });
      const replace = decision.kind !== 'reveal';
      let nextInput = query;

      if (replace) {
        if (
          (options.confirmScopeChange &&
            !(await this.prompts.offerNavigation?.(decision))) ||
          !current()
        )
          return;
        nextInput = { scope: decision.scope, text: '', cursor: null };
        result = allPage ?? (await scan(nextInput));
        if (!result || !current()) return;
      }

      await apply(
        {
          commit,
          page: result?.page ?? null,
          enrichments: result?.enrichments ?? [],
          input: nextInput,
          replace,
        },
        isLatest,
      );
    } catch (error) {
      if (isLatest()) throw error;
    }
  }
}
