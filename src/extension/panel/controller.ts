import type { Disposable } from 'vscode';

import { normalizeHistoryFilters } from '../../shared/history-filters';
import type {
  PanelBody,
  Request,
  RequestBody,
  Result,
  UserAction,
} from '../../shared/messages';
import type { HistoryInput, ScrollAnchor, Selection } from '../../shared/model';
import type { GitAdapter } from '../git/adapter';
import { runPanelAction } from './action-runner';
import type { ActionPrompts } from './actions';
import { PanelActions } from './actions';
import { type AuthorPicker, chooseHistoryAuthors } from './authors';
import type { CommitJump } from './commit-jump';
import { CommitNavigation, unavailableNavigation } from './commit-navigation';
import { PanelDetails } from './details';
import { PanelHistory } from './history';
import { restoreHistorySelection } from './history-restore';
import type { NavigationPrompts } from './navigate';
import { PanelNavigator } from './navigate';
import { comparisonSource, PanelNotifications } from './notifications';
import { describeLogAction } from './operation-description';
import { PanelOperations } from './operation-progress';
import { parseRequest } from './protocol';
import {
  type FileHandle,
  getRepository,
  QuerySession,
  waitForQuery,
} from './queries';
import { queuedActionCurrent } from './queued-action';
import { ReferencePublications } from './reference-publications';
import { createRepositoryList } from './repository-list';
import { DeferredRepositoryRefresh } from './repository-refresh';
import {
  openSelectedWorktree,
  PanelWorktrees,
  type WorktreeOpening,
} from './worktrees';
import { PanelWriteOwnership } from './write-ownership';

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
  visible?: boolean;
  nativeAction?: (action: 'trust' | 'source-control') => Promise<void>;
}
export type PanelRequest = Request<RequestBody>;
export class PanelController {
  private readonly session = new QuerySession();
  private readonly references = new ReferencePublications();
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
  private visible = true;
  private presentationDirty = false;
  private repositoryEpoch = 0;
  private readonly commitNavigation: CommitNavigation | null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly repositoryRefresh = new DeferredRepositoryRefresh();
  private readonly operations = new PanelOperations(
    ({ body, requestId, repositoryId }) =>
      this.send(body, requestId, repositoryId),
  );

  private readonly writes = new PanelWriteOwnership(
    this.session,
    this.operations,
    () => this.closed,
    (body, id, generation) => this.send(body, 'write-start', id, generation),
  );

  private refreshRestore: {
    repositoryId: string;
    selection: Selection | null;
    anchor: ScrollAnchor | null;
  } | null = null;

  private readonly repositorySubscription: Disposable | null;
  constructor(private readonly options: ControllerOptions) {
    this.visible = options.visible ?? true;
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
    this.commitNavigation =
      this.navigator && this.historyQuery && this.details
        ? new CommitNavigation({
            session: this.session,
            navigator: this.navigator,
            history: this.historyQuery,
            details: this.details,
            getInput: () => this.input,
            setInput: (input) => {
              this.input = input;
            },
            repository: (id) => this.repository(id),
            send: (body, requestId) => this.send(body, requestId),
            setup: () => this.setup(),
            selectRepository: (id, current) =>
              this.selectRepository(id, false, current),
            closed: () => this.closed,
          })
        : null;
    this.repositorySubscription =
      options.adapter?.subscribeRepositories((event) => {
        if (
          event?.kind === 'closed' &&
          event.repositoryId === this.session.repositoryId
        ) {
          this.repositoryEpoch++;
          this.subscription?.dispose();
          this.subscription = null;
          this.refreshRestore = null;
          this.commitNavigation?.cancel();
          this.session.begin('');
        }

        void this.repositoriesChanged().catch((error) =>
          this.notifications.readFailed(
            'history',
            error,
            'Repository refresh failed.',
          ),
        );
      }) ?? null;
  }

  private readonly repositoriesChanged = createRepositoryList({
    adapter: () => this.options.adapter,
    setup: () => this.setup(),
    current: () => !this.closed,
    selected: () => this.session.repositoryId,
    clear: () => {
      this.subscription?.dispose();
      this.refreshRestore = null;
      this.session.begin('');
    },
    send: (body) => this.send(body),
    select: (id) => this.selectRepository(id),
  });

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
      const publication = this.references.prepare(body, id, generation);

      await this.options.send({
        requestId,
        repositoryId: id,
        generation,
        body: publication.body,
      });
      publication.commit();
      if (body.kind === 'loading') await this.operations.publish(id);
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

  private readonly repository = (id: string) =>
    getRepository(this.options.adapter, id);

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

    const kind = request.body.kind;

    if (this.commitNavigation?.hostNavigation && kind === 'restore') return;

    if (
      kind === 'choose-repository' ||
      (kind === 'history' && request.body.cursor === null) ||
      (this.session.repositoryId === request.repositoryId &&
        this.session.generation === request.generation &&
        [
          'restore',
          'go-to',
          'refresh',
          'select-commit',
          'select-commits',
          'open-file',
        ].includes(kind))
    )
      this.commitNavigation?.cancel();

    try {
      const body = request.body;

      if (body.kind === 'trust' || body.kind === 'source-control') {
        await this.options.nativeAction?.(body.kind);

        return;
      }

      if (!(await this.setup())) return;
      if (body.kind === 'ready') {
        // A recreated webview needs normal initialization and saved-state restore.
        // Provider commit jumps start only after this ready request completes.
        if (this.commitNavigation) this.commitNavigation.hostNavigation = false;
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
      if (
        body.kind === 'action' &&
        this.operations.has(request.repositoryId, JSON.stringify(body.action))
      )
        return;
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
          await this.commitNavigation!.goTo(
            body.input,
            request,
            (generation) => {
              ownedGeneration = generation;
            },
          );
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

  async selectRepository(
    id: string,
    cancelNavigation = true,
    current = () => true,
  ): Promise<void> {
    if (cancelNavigation) this.commitNavigation?.cancel();
    if (!current() || !(await this.setup()) || !current()) return;
    this.repository(id);
    this.repositoryEpoch++;
    this.refreshRestore = null;
    if (this.session.repositoryId)
      this.options.adapter!.invalidateHistory(this.session.repositoryId);
    this.subscription?.dispose();
    this.session.begin(id);
    this.input = { scope: { kind: 'head' }, text: '', cursor: null };
    const changed = () => {
      if (this.closed || this.session.repositoryId !== id) return;
      if (this.repositoryRefresh.defer(id, changed)) {
        if (this.operations.isRefreshing(id)) {
          this.commitNavigation?.pauseForRefresh();
          this.session.abort.abort();
        }

        return;
      }

      // Invalidate immediately; a slow read must not publish during the debounce.
      this.commitNavigation?.pauseForRefresh();
      this.session.abort.abort();
      if (!this.visible) {
        this.presentationDirty = true;

        return;
      }

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
    if (!this.visible) {
      this.presentationDirty = true;

      return;
    }

    await this.historyQuery!.load(
      this.input,
      'select-repository',
      null,
      false,
      current,
    );
  }

  async revealCommit(target: CommitJump, current = () => true): Promise<void> {
    if (!this.commitNavigation) throw unavailableNavigation();
    await this.commitNavigation.revealCommit(target, current);
  }

  private async action(
    action: UserAction,
    request: PanelRequest,
  ): Promise<void> {
    const epoch = this.repositoryEpoch;
    const current = queuedActionCurrent(action, this.session);
    const prepared =
      action.kind === 'update-branch'
        ? this.actions!.prepareUpdate(action.refId)
        : undefined;

    await this.operations.run({
      repositoryId: request.repositoryId,
      requestId: request.requestId,
      description: describeLogAction(action),
      key: JSON.stringify(action),
      independent: prepared !== undefined,
      work: async (progress) => {
        if (
          this.closed ||
          !this.options.trusted() ||
          epoch !== this.repositoryEpoch
        )
          return;
        if (!prepared && !current())
          throw new Error(
            'The target of the queued action changed. Select it and try again.',
          );
        await runPanelAction(
          action,
          {
            ...request,
            generation: this.session.generation,
          },
          {
            session: this.session,
            adapter: this.options.adapter!,
            actions: this.actions!,
            repositoryRefresh: this.repositoryRefresh,
            operations: this.operations,
            progress,
            options: this.options,
            closed: () => this.closed,
            refresh: () => this.refresh(),
            beginWrite: () => this.writes.begin(request.repositoryId),
            send: (body, requestId) => this.send(body, requestId),
          },
          prepared,
        );
      },
    });
  }

  private reload(
    desired: Selection | null,
    anchor: ScrollAnchor | null,
    requestId: string,
  ): Promise<void> {
    return restoreHistorySelection({
      session: this.session,
      query: this.input,
      history: this.historyQuery!,
      adapter: this.options.adapter!,
      details: this.details!,
      desired,
      anchor,
      requestId,
      send: (body, request, id, generation) =>
        this.send(body, request, id, generation),
      onScopeChange: (query) => {
        this.input = query;
      },
    });
  }

  async setVisible(visible: boolean): Promise<void> {
    this.visible = visible;
    if (this.closed) return;
    if (!visible) this.commitNavigation?.cancel();
    if (!visible && this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      this.presentationDirty = true;
    }

    if (visible && this.presentationDirty) {
      if (
        this.repositoryRefresh.defer(this.session.repositoryId, () => {
          void this.refresh();
        })
      )
        return;
      await this.refresh();
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
    if (!this.visible) {
      this.options.adapter!.invalidateHistory(id);
      this.session.abort.abort();
      this.presentationDirty = true;

      return;
    }

    this.presentationDirty = false;
    const pending =
      this.refreshRestore?.repositoryId === id ? this.refreshRestore : null;
    const desired = this.session.selection ?? pending?.selection ?? null;
    const anchor = this.session.anchor ?? pending?.anchor ?? null;

    this.options.adapter!.invalidateHistory(id);
    this.session.begin(id);
    const generation = this.session.generation;
    const signal = this.session.abort.signal;

    this.refreshRestore = { repositoryId: id, selection: desired, anchor };
    try {
      await waitForQuery(
        Promise.all([
          this.reload(desired, anchor, 'refresh'),
          this.worktreeQuery.load(),
        ]),
        signal,
      );
    } catch (error) {
      if (this.session.current(id, generation)) {
        this.commitNavigation?.refreshSettled({ kind: 'failed' });
        await this.notifications.readFailed(
          'history',
          error,
          'Refresh failed.',
          'refresh',
          id,
          generation,
        );
      }

      return;
    }

    if (!this.session.current(id, generation)) return;
    this.refreshRestore = null;
    this.commitNavigation?.refreshSettled();
  }

  dispose(): void {
    this.closed = true;
    this.commitNavigation?.cancel();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.subscription?.dispose();
    this.repositorySubscription?.dispose();
    this.session.dispose();
    this.options.adapter?.dispose();
  }
}
