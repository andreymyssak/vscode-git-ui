import type {
  CommitRecord,
  HistoryInput,
  HistoryPage,
  Reference,
} from '../../shared/model';
import type { GitAdapter } from '../git/adapter';
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
      let target = await this.adapter.resolve(id, input);

      if (!current()) return;
      if (target.kind === 'choices') {
        const ref = await this.prompts.pickReference?.(target.references);

        if (!ref || !current()) return;
        target = await this.adapter.resolve(id, ref);
      }

      if (!current()) return;

      if (target.kind !== 'commit') {
        if (target.kind === 'missing' || target.kind === 'ambiguous')
          throw new Error(target.message);

        return;
      }

      const commit = target.commit;
      const signal = this.session.abort.signal;
      const scan = async (input: HistoryInput): Promise<HistoryPage | null> => {
        const commits: HistoryPage['commits'] = [];
        let cursor: string | null = null;

        do {
          signal.throwIfAborted();
          this.session.abort.signal.throwIfAborted();
          if (!current()) return null;
          const page = await this.adapter.history(
            id,
            { ...input, cursor },
            signal,
          );

          commits.push(...page.commits);
          if (page.commits.some((item) => item.sha === commit.sha))
            return { ...page, commits };
          cursor = page.nextCursor;
        } while (cursor);

        return null;
      };

      let page = this.session.commits.has(commit.sha)
        ? null
        : await scan(query);
      const inQuery = this.session.commits.has(commit.sha) || page !== null;
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
        page = allPage ?? (await scan(nextInput));
        if (!page || !current()) return;
      }

      await apply({ commit, page, input: nextInput, replace }, isLatest);
    } catch (error) {
      if (isLatest()) throw error;
    }
  }
}
