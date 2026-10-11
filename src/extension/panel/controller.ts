import type { Disposable } from 'vscode';

import { normalizeHistoryFilters } from '../../shared/history-filters';
import type {
  PanelBody,
  Request,
  RequestBody,
  Result,
  UserAction,
} from '../../shared/messages';
import type {
  HistoryInput,
  RepositoryInfo,
  ScrollAnchor,
  Selection,
} from '../../shared/model';
import type { GitAdapter } from '../git/adapter';
import type { ActionPrompts } from './actions';
import {
  isHistoryRewrite,
  offerBranchRestore,
  PanelActions,
  publishOperationResult,
} from './actions';
import { type AuthorPicker, chooseHistoryAuthors } from './authors';
import { PanelDetails } from './details';
import { PanelHistory } from './history';
import type { NavigationPrompts } from './navigate';
import { PanelNavigator } from './navigate';
import { comparisonSource, PanelNotifications } from './notifications';
import { parseRequest } from './protocol';
import { type FileHandle, QuerySession } from './queries';
import { DeferredRepositoryRefresh } from './repository-refresh';
import { reconcileSelection } from './selection';
import {
  openSelectedWorktree,
  PanelWorktrees,
  type WorktreeOpening,
} from './worktrees';

export interface ControllerOptions
  extends ActionPrompts, NavigationPrompts, WorktreeOpening {
  adapter: GitAdapter | null;
  trusted: () => boolean;
  send: (message: Result<PanelBody>) => void | Promise<void>;
  openChange: (
    repositoryId: string,
    handle: FileHandle,
    preview: boolean,
    current: () => boolean,
  ) => Promise<void>;
  pickRepository: () => Promise<string | null>;
  pickAuthors?: AuthorPicker;
  initialRepositoryId: string | null;
  setupError?: string | null;
  nativeAction?: (action: 'trust' | 'source-control') => Promise<void>;
}
export type PanelRequest = Request<RequestBody>;
export class PanelController {
  private readonly session = new QuerySession();
  private readonly actions: PanelActions | null;
  private readonly navigator: PanelNavigator | null;
  private readonly historyQuery: PanelHistory | null;
  private readonly details: PanelDetails | null;
  private readonly notifications: PanelNotifications;
  private readonly worktreeQuery: PanelWorktrees;
  private input: HistoryInput = {
    scope: { kind: 'head' },
    text: '',
    cursor: null,
  };

  private subscription: Disposable | null = null;
  private closed = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly repositoryRefresh = new DeferredRepositoryRefresh();
  private refreshRestore: {
    repositoryId: string;
    selection: Selection | null;
    anchor: ScrollAnchor | null;
  } | null = null;

  private readonly repositorySubscription: Disposable | null;
  constructor(private readonly options: ControllerOptions) {
    this.notifications = new PanelNotifications({
      report: options.reportActionError,
      session: this.session,
      closed: () => this.closed,
      send: (body, requestId, id, generation) =>
        this.send(body, requestId, id, generation),
    });
    this.worktreeQuery = new PanelWorktrees({
      adapter: options.adapter,
      session: this.session,
      notifications: this.notifications,
      send: (body, requestId) => this.send(body, requestId),
    });
    this.actions = options.adapter
      ? new PanelActions(options.adapter, this.session, options)
      : null;
    this.navigator = options.adapter
      ? new PanelNavigator(options.adapter, this.session, options)
      : null;
    this.historyQuery = options.adapter
      ? new PanelHistory(options.adapter, this.session, {
          repository: (id) => this.repository(id),
          send: (body, requestId, id, generation) =>
            this.send(body, requestId, id, generation),
        })
      : null;
    this.details = options.adapter
      ? new PanelDetails(options.adapter, this.session, {
          send: (body, requestId) => this.send(body, requestId),
          reportError: (id, sha, parentSha, message) =>
            this.notifications.failed(
              id,
              comparisonSource(sha, parentSha),
              message,
            ),
          openChange: (id, handle, preview, current) =>
            options.openChange(
              id,
              handle,
              preview,
              () => options.trusted() && current(),
            ),
        })
      : null;
    this.repositorySubscription =
      options.adapter?.subscribeRepositories(() => {
        void this.repositoriesChanged().catch((error) =>
          this.notifications.readFailed(
            'history',
            error,
            'Repository refresh failed.',
          ),
        );
      }) ?? null;
  }

  private async repositoriesChanged(): Promise<void> {
    if (this.closed || !(await this.setup())) return;
    const repositories = this.options.adapter?.repositories() ?? [];

    if (!repositories.length) {
      this.subscription?.dispose();
      this.refreshRestore = null;
      this.session.begin('');
      await this.send({
        kind: 'setup',
        state: 'no-repository',
        message: 'Open a folder containing a Git repository.',
        repositories: [],
      });

      return;
    }

    await this.send({
      kind: 'setup',
      state: 'ready',
      message: '',
      repositories,
    });
    // Open/close events change the chooser; selected-repository state has its own subscription.
    if (!repositories.some((repo) => repo.id === this.session.repositoryId)) {
      const first = repositories[0];

      if (first) await this.selectRepository(first.id);
    }
  }

  private async send(
    body: PanelBody,
    requestId = 'host',
    id = this.session.repositoryId,
    generation = this.session.generation,
  ): Promise<void> {
    if (!this.closed) {
      this.notifications.succeeded(id, body);
      if (body.kind === 'notice')
        await this.options.reportActionInfo?.(body.message);
      await this.options.send({
        requestId,
        repositoryId: id,
        generation,
        body,
      });
    }
  }

  private async setup(): Promise<boolean> {
    if (!this.options.trusted()) {
      await this.send({
        kind: 'setup',
        state: 'untrusted',
        message: 'Trust this workspace through VS Code to use Git.',
        repositories: [],
      });

      return false;
    }

    if (!this.options.adapter) {
      if (this.options.setupError)
        await this.notifications.failed('', 'setup', this.options.setupError);
      await this.send({
        kind: 'setup',
        state: 'git-disabled',
        message:
          'Enable the built-in Git extension and Git in VS Code settings, and install Git.',
        repositories: [],
      });

      return false;
    }

    return true;
  }

  private repository(id: string): RepositoryInfo {
    const repository = this.options.adapter
      ?.repositories()
      .find((repo) => repo.id === id);

    if (!repository)
      throw new Error('Repository is no longer available. Refresh the view.');

    return repository;
  }

  async handle(value: unknown): Promise<void> {
    if (this.closed) return;
    const request = parseRequest(value);

    if (!request) {
      const message = 'The panel sent an invalid request.';

      await this.options.reportActionError?.(message);
      await this.send({ kind: 'error', message });

      return;
    }

    let ownedGeneration = request.generation;

    try {
      const body = request.body;

      if (body.kind === 'trust' || body.kind === 'source-control') {
        await this.options.nativeAction?.(body.kind);

        return;
      }

      if (!(await this.setup())) return;
      if (body.kind === 'ready') {
        const repositories = this.options.adapter?.repositories() ?? [];

        if (!repositories.length) {
          await this.send({
            kind: 'setup',
            state: 'no-repository',
            message: 'Open a folder containing a Git repository.',
            repositories: [],
          });

          return;
        }

        await this.send({
          kind: 'setup',
          state: 'ready',
          message: '',
          repositories,
        });
        const preferred = [
          body.savedRepositoryId,
          this.options.initialRepositoryId,
        ].find((id) => repositories.some((repo) => repo.id === id));

        await this.selectRepository(preferred ?? repositories[0]?.id ?? '');

        return;
      }

      if (body.kind === 'choose-repository') {
        const id = await this.options.pickRepository();

        if (id) await this.selectRepository(id);

        return;
      }

      this.repository(request.repositoryId);
      if (request.repositoryId !== this.session.repositoryId)
        throw new Error('This request belongs to another repository.');
      if (body.kind === 'history') {
        const desired = this.session.selection;
        const anchor = this.session.anchor;

        if (body.cursor === null) {
          this.refreshRestore = null;
          // A repository event may advance the host before the panel sees it.
          // Fresh user intent supersedes reads; cursor and write handles stay strict.
          this.session.begin(
            request.repositoryId,
            Math.max(request.generation, this.session.generation + 1),
          );
          ownedGeneration = this.session.generation;
          this.input = {
            scope: body.scope,
            text: body.text,
            cursor: null,
            filters: normalizeHistoryFilters(body.filters),
          };
        } else if (
          !this.session.current(request.repositoryId, request.generation) ||
          JSON.stringify(body.scope) !== JSON.stringify(this.input.scope) ||
          body.text !== this.input.text ||
          JSON.stringify(normalizeHistoryFilters(body.filters)) !==
            JSON.stringify(normalizeHistoryFilters(this.input.filters))
        )
          throw new Error('This history page is obsolete.');
        if (body.cursor === null)
          await this.reload(desired, anchor, request.requestId);
        else
          await this.historyQuery!.load(
            this.input,
            request.requestId,
            body.cursor,
          );

        return;
      }

      if (!this.session.current(request.repositoryId, request.generation))
        throw new Error('This request is obsolete.');
      switch (body.kind) {
        case 'restore': {
          this.refreshRestore = null;
          this.input = {
            scope: body.scope,
            text: body.text,
            cursor: null,
            filters: normalizeHistoryFilters(body.filters),
          };
          this.session.begin(request.repositoryId);
          ownedGeneration = this.session.generation;
          await this.reload(body.selection, body.anchor, request.requestId);
          break;
        }

        case 'anchor':
          if (body.anchor && !this.session.commits.has(body.anchor.sha))
            throw new Error('Scroll anchor is no longer loaded.');
          this.session.anchor = body.anchor;
          if (this.refreshRestore) this.refreshRestore.anchor = body.anchor;
          break;
        case 'choose-authors': {
          const response = await chooseHistoryAuthors(
            this.options.adapter!,
            this.session,
            request,
            this.input,
            this.options.pickAuthors,
          );

          if (
            response &&
            this.session.current(request.repositoryId, request.generation)
          )
            await this.send(response, request.requestId);
          break;
        }

        case 'invalid-date-filter':
          await this.options.reportActionError?.(
            'Start date must be on or before end date.',
          );
          break;

        case 'go-to':
          await this.goTo(body.input, request, (generation) => {
            ownedGeneration = generation;
          });
          break;
        case 'refresh':
          this.notifications.retry();

          return await this.refresh();
        case 'select-commit':
          await this.details!.select([body.sha], body.sha, request.requestId);
          break;
        case 'select-commits':
          await this.details!.select(
            body.shas,
            body.activeSha,
            request.requestId,
          );
          break;
        case 'load-parent':
          await this.details!.parent(
            body.sha,
            body.parentSha,
            request.requestId,
          );
          break;
        case 'open-file':
          await this.details!.open(body.fileId, body.preview);
          break;

        case 'action':
          await this.action(body.action, request);
          break;
        case 'worktrees':
          if (body.retry) this.notifications.retry('worktrees');

          return await this.worktreeQuery.load(request.requestId);

        case 'open-worktree':
          await openSelectedWorktree(
            this.options.adapter!,
            this.session,
            request,
            body,
            this.options,
          );
          break;

        default: {
          const exhaustive: never = body;

          return exhaustive;
        }
      }
    } catch (error) {
      await this.notifications.requestFailed({
        error,
        request,
        ownedGeneration,
      });
    }
  }

  async selectRepository(id: string): Promise<void> {
    if (!(await this.setup())) return;
    this.repository(id);
    this.refreshRestore = null;
    if (this.session.repositoryId)
      this.options.adapter!.invalidateHistory(this.session.repositoryId);
    this.subscription?.dispose();
    this.session.begin(id);
    this.input = { scope: { kind: 'head' }, text: '', cursor: null };
    const changed = () => {
      if (this.closed || this.session.repositoryId !== id) return;
      if (this.repositoryRefresh.defer(id, changed)) return;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        if (this.closed || this.session.repositoryId !== id) return;
        if (this.repositoryRefresh.defer(id, changed)) return;
        void this.refresh().catch((error) =>
          this.notifications.readFailed('history', error, 'Refresh failed.'),
        );
      }, 50);
    };

    this.subscription = this.options.adapter!.subscribe(id, changed);
    await this.historyQuery!.load(this.input, 'select-repository', null);
  }

  private async goTo(
    input: string,
    request: PanelRequest,
    assigned: (generation: number) => void,
  ): Promise<void> {
    const id = request.repositoryId;

    await this.navigator!.navigate(
      id,
      input,
      this.input,
      async ({ commit, page, input: nextInput, replace }, isLatest) => {
        let generation = this.session.generation;

        if (replace) {
          this.input = nextInput;
          this.session.begin(id);
          generation = this.session.generation;
          assigned(this.session.generation);
          await this.send(
            {
              kind: 'loading',
              scope: this.input.scope,
              text: '',
              repository: this.repository(id),
              filters: normalizeHistoryFilters(this.input.filters),
            },
            request.requestId,
          );
        }

        if (!this.session.current(id, generation) || !isLatest()) return;
        if (page) {
          await this.historyQuery!.publish(
            page,
            this.input,
            request.requestId,
            !replace,
          );
        }

        if (!this.session.current(id, generation) || !isLatest()) return;
        this.session.commits.set(commit.sha, commit);
        const epoch = this.session.select(commit.sha);

        await this.send({ kind: 'reveal', sha: commit.sha }, request.requestId);
        if (!this.session.current(id, generation) || !isLatest()) return;
        await this.send({ kind: 'details', commit }, request.requestId);
        if (!this.session.current(id, generation) || !isLatest()) return;
        await this.details!.files(
          commit.sha,
          commit.parents[0] ?? null,
          epoch,
          request.requestId,
        );
      },
    );
  }

  private async action(
    action: UserAction,
    request: PanelRequest,
  ): Promise<void> {
    const rangeRevision = this.session.rangeRevision;
    const reviewed = await this.actions!.review(action, request);
    const operation = reviewed.action;

    if (!operation) return;
    const rewritesHistory = isHistoryRewrite(action);
    const pause = rewritesHistory
      ? this.repositoryRefresh.pause(request.repositoryId)
      : null;

    try {
      if (
        operation.kind === 'edit-commit-message' &&
        (!this.session.current(request.repositoryId, request.generation) ||
          reviewed.context?.aborted)
      )
        throw new Error(
          'The history changed before the commit message could be saved. Select the commit again.',
        );
      const result = await this.options.adapter!.operate(
        request.repositoryId,
        operation,
        reviewed.context,
      );

      if (
        !this.closed &&
        (rewritesHistory || action.kind === 'cherry-pick-commits') &&
        result.kind === 'cancelled'
      )
        await this.options.reportActionError?.(
          'The history operation was cancelled because the view context changed. The commits were left unchanged.',
        );
      if (rewritesHistory) {
        if (
          this.closed ||
          !this.session.current(request.repositoryId, request.generation) ||
          this.session.rangeRevision !== rangeRevision ||
          reviewed.context?.aborted
        ) {
          if (result.kind === 'error' || result.kind === 'conflict')
            await this.options.reportActionError?.(result.message);

          return;
        }

        if (result.kind === 'success' && result.replacementSha)
          this.session.selection = {
            sha: result.replacementSha,
            parentSha: null,
            filePath: null,
          };
      }

      const current = () =>
        !this.closed && this.session.repositoryId === request.repositoryId;
      const deletionReported = offerBranchRestore(
        result,
        request.repositoryId,
        {
          ...this.options,
          adapter: this.options.adapter!,
          current,
          refresh: () => this.refresh(),
        },
      );

      await publishOperationResult(result, action.kind, {
        current,
        refresh: () => this.refresh(),
        send: (result) =>
          this.send({ kind: 'operation', result }, request.requestId),
        reportError: deletionReported
          ? undefined
          : this.options.reportActionError,
        reportInfo: deletionReported
          ? undefined
          : this.options.reportActionInfo,
      });
    } finally {
      pause?.dispose();
    }
  }

  private async reload(
    desired: Selection | null,
    anchor: ScrollAnchor | null,
    requestId: string,
  ): Promise<void> {
    const id = this.session.repositoryId;
    const generation = this.session.generation;
    const current = () => this.session.current(id, generation);
    const selectionEpoch = this.session.detailEpoch;

    try {
      if (this.input.scope.kind === 'ref') {
        const refId = this.input.scope.refId;
        const refs = await this.options.adapter!.references(id);

        if (!current()) return;
        if (!refs.some((ref) => ref.id === refId)) {
          this.input = { ...this.input, scope: { kind: 'head' } };
          await this.send(
            {
              kind: 'notice',
              message: 'The selected reference disappeared. Showing HEAD.',
            },
            requestId,
          );
        }
      }

      let page = await this.historyQuery!.load(
        this.input,
        requestId,
        null,
        true,
      );

      while (
        page?.nextCursor &&
        current() &&
        this.session.detailEpoch === selectionEpoch &&
        ((desired && !this.session.commits.has(desired.sha)) ||
          (anchor && !this.session.commits.has(anchor.sha)))
      )
        page = await this.historyQuery!.load(
          this.input,
          requestId,
          page.nextCursor,
          true,
        );
      if (!current() || this.session.detailEpoch !== selectionEpoch) return;
      const retainedAnchor =
        anchor && this.session.commits.has(anchor.sha) ? anchor : null;
      const commit = desired ? this.session.commits.get(desired.sha) : null;

      if (!desired || !commit) {
        this.session.selection = null;
        this.session.selectedSha = null;
        this.session.anchor = retainedAnchor;
        await this.send(
          {
            kind: 'selection',
            sha: null,
            parentSha: null,
            filePath: null,
            anchor: retainedAnchor,
          },
          requestId,
        );

        return;
      }

      const valid = reconcileSelection(desired, {
        inQuery: true,
        parents: commit.parents,
        files: desired.filePath ? [desired.filePath] : [],
      })!;
      const epoch = this.session.select(valid.sha);

      this.session.selection = valid;
      this.session.anchor = retainedAnchor;
      await this.send(
        { kind: 'selection', ...valid, anchor: retainedAnchor },
        requestId,
      );
      await this.send({ kind: 'details', commit }, requestId);
      await this.details!.files(valid.sha, valid.parentSha, epoch, requestId);
      if (
        !current() ||
        this.session.selectedSha !== valid.sha ||
        this.session.detailEpoch !== epoch
      )
        return;
      const paths = [...this.session.files.values()]
        .filter((handle) => handle.parentSha === valid.parentSha)
        .flatMap((handle) =>
          [handle.file.newPath, handle.file.oldPath].filter(
            (path): path is string => path !== null,
          ),
        );
      const selection = reconcileSelection(valid, {
        inQuery: true,
        parents: commit.parents,
        files: paths,
      })!;

      this.session.selection = selection;
      await this.send(
        { kind: 'selection', ...selection, anchor: retainedAnchor },
        requestId,
      );
    } finally {
      if (current())
        await this.send({ kind: 'history-settled' }, requestId, id, generation);
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.closed || !(await this.setup())) return;
    const id = this.session.repositoryId;

    if (!id) return;
    this.repositoryRefresh.clear(id);
    const pending =
      this.refreshRestore?.repositoryId === id ? this.refreshRestore : null;
    const desired = this.session.selection ?? pending?.selection ?? null;
    const anchor = this.session.anchor ?? pending?.anchor ?? null;

    this.options.adapter!.invalidateHistory(id);
    this.session.begin(id);
    const generation = this.session.generation;

    this.refreshRestore = { repositoryId: id, selection: desired, anchor };
    try {
      await this.reload(desired, anchor, 'refresh');
    } catch (error) {
      if (this.session.current(id, generation))
        await this.notifications.readFailed(
          'history',
          error,
          'Refresh failed.',
          'refresh',
          id,
          generation,
        );

      return;
    }

    if (!this.session.current(id, generation)) return;
    this.refreshRestore = null;
    await this.worktreeQuery.load();
  }

  dispose(): void {
    this.closed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.subscription?.dispose();
    this.repositorySubscription?.dispose();
    this.session.dispose();
    this.options.adapter?.dispose();
  }
}
