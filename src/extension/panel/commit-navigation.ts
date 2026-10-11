import { extensionIdentity } from '../../shared/extension-identity';
import { normalizeHistoryFilters } from '../../shared/history-filters';
import type { PanelBody, Request, RequestBody } from '../../shared/messages';
import type { HistoryInput, RepositoryInfo } from '../../shared/model';
import type { CommitJump } from './commit-jump';
import type { PanelDetails } from './details';
import type { PanelHistory } from './history';
import type { PanelNavigator } from './navigate';
import type { QuerySession } from './queries';

interface CommitNavigationPorts {
  session: QuerySession;
  navigator: PanelNavigator;
  history: PanelHistory;
  details: PanelDetails;
  getInput(): HistoryInput;
  setInput(input: HistoryInput): void;
  repository(id: string): RepositoryInfo;
  send(body: PanelBody, requestId: string): Promise<void>;
  setup(): Promise<boolean>;
  selectRepository(id: string): Promise<void>;
  closed(): boolean;
}

/** Publishes a commit jump through the existing query and detail session. */
export class CommitNavigation {
  private navigationRevision = 0;
  hostNavigation = false;

  constructor(private readonly ports: CommitNavigationPorts) {}

  cancel(): void {
    this.navigationRevision++;
    this.ports.navigator.cancel();
  }

  async goTo(
    input: string,
    request: Pick<Request<RequestBody>, 'repositoryId' | 'requestId'>,
    assigned: (generation: number) => void,
    options: { confirmScopeChange: boolean } = { confirmScopeChange: true },
  ): Promise<void> {
    const id = request.repositoryId;

    await this.ports.navigator.navigate(
      id,
      input,
      this.ports.getInput(),
      async ({ commit, page, input: nextInput, replace }, isLatest) => {
        let generation = this.ports.session.generation;

        if (replace) {
          this.ports.setInput(nextInput);
          this.ports.session.begin(id);
          generation = this.ports.session.generation;
          assigned(this.ports.session.generation);
          await this.ports.send(
            {
              kind: 'loading',
              scope: this.ports.getInput().scope,
              text: '',
              repository: this.ports.repository(id),
              filters: normalizeHistoryFilters(this.ports.getInput().filters),
            },
            request.requestId,
          );
        }

        if (!this.ports.session.current(id, generation) || !isLatest()) return;
        if (page) {
          await this.ports.history.publish(
            page,
            this.ports.getInput(),
            request.requestId,
            !replace,
          );
        }

        if (!this.ports.session.current(id, generation) || !isLatest()) return;
        this.ports.session.commits.set(commit.sha, commit);
        const epoch = this.ports.session.select(commit.sha);

        await this.ports.send(
          { kind: 'reveal', sha: commit.sha },
          request.requestId,
        );
        if (!this.ports.session.current(id, generation) || !isLatest()) return;
        await this.ports.send({ kind: 'details', commit }, request.requestId);
        if (!this.ports.session.current(id, generation) || !isLatest()) return;
        await this.ports.details.files(
          commit.sha,
          commit.parents[0] ?? null,
          epoch,
          request.requestId,
        );
      },
      options,
    );
  }

  async revealCommit(target: CommitJump): Promise<void> {
    if (this.ports.closed())
      throw new DOMException(
        `${extensionIdentity.displayName} was closed.`,
        'AbortError',
      );
    const first = !this.hostNavigation;

    this.hostNavigation = true;
    const revision = ++this.navigationRevision;

    this.ports.navigator.cancel();
    if (!(await this.ports.setup()))
      throw new Error(
        `${extensionIdentity.displayName} is unavailable for commit navigation.`,
      );
    const current = () =>
      !this.ports.closed() && revision === this.navigationRevision;

    if (!current()) return;
    this.ports.repository(target.repositoryId);
    await this.ports.send({ kind: 'focus-log' }, 'commit-jump');
    if (!current()) return;
    if (this.ports.session.repositoryId !== target.repositoryId) {
      await this.ports.selectRepository(target.repositoryId);
    } else if (first) {
      this.ports.session.begin(target.repositoryId);
      await this.ports.history.load(this.ports.getInput(), 'commit-jump', null);
    }

    if (!current()) return;
    await this.goTo(
      target.sha,
      { repositoryId: target.repositoryId, requestId: 'commit-jump' },
      () => {},
      { confirmScopeChange: false },
    );
  }
}
