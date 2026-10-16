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
  selectRepository(id: string, current: () => boolean): Promise<void>;
  closed(): boolean;
}

type RefreshResult = { kind: 'ready' } | { kind: 'failed' };

interface HostJump {
  epoch: number;
  refresh: {
    completion: Promise<RefreshResult>;
    finish(result: RefreshResult): void;
  } | null;
}

/** Publishes a commit jump through the existing query and detail session. */
export class CommitNavigation {
  private navigationRevision = 0;
  private hostJump: HostJump | null = null;
  hostNavigation = false;

  constructor(private readonly ports: CommitNavigationPorts) {}

  cancel(): void {
    this.navigationRevision++;
    this.ports.navigator.cancel();
    this.refreshSettled();
    this.hostJump = null;
  }

  pauseForRefresh(): void {
    const jump = this.hostJump;

    if (!jump) return;
    // Retire the old read immediately, but retain its immutable user target.
    jump.epoch++;
    jump.refresh?.finish({ kind: 'ready' });
    let finish: (result: RefreshResult) => void = () => {};

    const completion = new Promise<RefreshResult>((resolve) => {
      finish = resolve;
    });

    jump.refresh = { completion, finish };
    this.ports.navigator.cancel();
  }

  refreshSettled(result: RefreshResult = { kind: 'ready' }): void {
    this.hostJump?.refresh?.finish(result);
  }

  async goTo(
    input: string,
    request: Pick<Request<RequestBody>, 'repositoryId' | 'requestId'>,
    assigned: (generation: number) => void,
    options: {
      confirmScopeChange: boolean;
      isCurrent?: () => boolean;
      filePath?: string;
    } = {
      confirmScopeChange: true,
    },
  ): Promise<void> {
    const id = request.repositoryId;

    await this.ports.navigator.navigate(
      id,
      input,
      this.ports.getInput(),
      async (
        { commit, page, input: nextInput, replace, enrichments },
        isLatest,
      ) => {
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
            false,
            enrichments,
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
          isLatest,
        );
        if (options.filePath)
          await this.revealFile({
            sha: commit.sha,
            parents: commit.parents.length ? commit.parents : [null],
            path: options.filePath,
            epoch,
            requestId: request.requestId,
            current: () =>
              this.ports.session.current(id, generation) &&
              this.ports.session.detailEpoch === epoch &&
              isLatest(),
          });
      },
      options,
    );
  }

  async revealCommit(
    target: CommitJump,
    sourceCurrent = () => true,
  ): Promise<void> {
    if (!sourceCurrent()) return;
    if (this.ports.closed())
      throw new DOMException(
        `${extensionIdentity.displayName} was closed.`,
        'AbortError',
      );
    const first = !this.hostNavigation;

    this.hostNavigation = true;
    this.cancel();
    const revision = this.navigationRevision;
    const jump: HostJump = { epoch: 0, refresh: null };

    this.hostJump = jump;
    const latest = () =>
      !this.ports.closed() &&
      revision === this.navigationRevision &&
      sourceCurrent();
    let initialize = first;

    try {
      while (latest()) {
        const refresh = jump.refresh;

        if (refresh) {
          const result = await refresh.completion;

          if (!latest()) return;
          if (jump.refresh !== refresh) continue;
          jump.refresh = null;
          // The normal refresh owns failure reporting, including native notices.
          if (result.kind === 'failed')
            throw new DOMException('History refresh failed.', 'AbortError');
        }

        const epoch = jump.epoch;
        const current = () => latest() && epoch === jump.epoch;

        try {
          await this.revealTarget(target, current, initialize);
        } catch (error) {
          if (!latest()) return;
          if (!jump.refresh) throw error;
        }

        initialize = false;
        if (!jump.refresh) return;
      }
    } finally {
      if (this.hostJump === jump) this.hostJump = null;
    }
  }

  private async revealTarget(
    target: CommitJump,
    current: () => boolean,
    initialize: boolean,
  ): Promise<void> {
    if (!(await this.ports.setup())) throw unavailableNavigation();
    if (!current()) return;
    this.ports.repository(target.repositoryId);
    await this.ports.send({ kind: 'focus-log' }, 'commit-jump');
    if (!current()) return;
    if (this.ports.session.repositoryId !== target.repositoryId) {
      await this.ports.selectRepository(target.repositoryId, current);
    } else if (initialize) {
      this.ports.session.begin(target.repositoryId);
      await this.ports.history.load(
        this.ports.getInput(),
        'commit-jump',
        null,
        false,
        current,
      );
    }

    if (!current()) return;
    await this.goTo(
      target.sha,
      { repositoryId: target.repositoryId, requestId: 'commit-jump' },
      () => {},
      {
        confirmScopeChange: false,
        isCurrent: current,
        ...(target.filePath === undefined ? {} : { filePath: target.filePath }),
      },
    );
  }

  private async revealFile({
    sha,
    parents,
    path,
    epoch,
    requestId,
    current,
  }: {
    sha: string;
    parents: readonly (string | null)[];
    path: string;
    epoch: number;
    requestId: string;
    current: () => boolean;
  }): Promise<void> {
    for (const [index, parentSha] of parents.entries()) {
      if (!current()) return;
      if (index > 0)
        await this.ports.details.files(
          sha,
          parentSha,
          epoch,
          requestId,
          current,
        );
      if (!current()) return;
      const files = [...this.ports.session.files.values()].filter(
        (handle) => handle.sha === sha && handle.parentSha === parentSha,
      );
      const handle =
        files.find(({ file }) => file.newPath === path) ??
        files.find(({ file }) => file.oldPath === path);

      if (!handle) continue;
      this.ports.session.selection = {
        sha,
        parentSha,
        filePath: handle.file.newPath ?? handle.file.oldPath,
      };
      this.ports.session.anchor = { sha, offset: 0 };
      await this.ports.send(
        {
          kind: 'selection',
          ...this.ports.session.selection,
          anchor: this.ports.session.anchor,
        },
        requestId,
      );

      return;
    }
  }
}

export function unavailableNavigation(): Error {
  return new Error(
    `${extensionIdentity.displayName} is unavailable for commit navigation.`,
  );
}
