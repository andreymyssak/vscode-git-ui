import * as vscode from 'vscode';

import type {
  SourceControlRequest,
  SourceControlState,
} from '../../shared/source-control';
import {
  dirtySelectedDocuments,
  saveSelectedDocuments,
} from '../changes/prompts';
import {
  createSourceControlBackend,
  type SourceControlBackend,
} from '../git/source-control/index';
import { generateCommitMessage } from '../native/commit-message';
import { openedChangePath } from '../native/opened-change';
import { showOperationError } from '../native/operation-feedback';
import { openSourceControlDiff } from '../native/source-control-diffs';
import { abortOperation } from './abort';
import { publishSourceControlContexts } from './context';
import { discardWorking } from './discard';
import { inspectWorkingFiles, writeWorkingFiles } from './file-actions';
import { toggleAmend } from './message-tools';
import { SourceControlModel } from './model';
import { SourceControlNotifications } from './notifications';
import { SourceControlReadProgress } from './read-progress';
import { refreshRepositories } from './refresh';
import { RefreshCompletion } from './refresh-completion';
import {
  isRepositoryAction,
  repositoryActionTitles,
  runRepositoryAction,
} from './repository-action';
import { rollbackChanges } from './rollback';
import { savedWriteDescription, writeSaved } from './saved-writes';
import { errorMessage, loaded, publicationState } from './state';
import { runSourceControlWrite } from './write-lifecycle';
import { requireLiveRepository, writeChanges } from './writes';

/** This service outlives hidden or recreated webviews; requests never own Git refs. */
export class SourceControlService implements vscode.Disposable {
  readonly model: SourceControlModel;
  private runtime: SourceControlBackend | null = null;
  private initializing: Promise<SourceControlBackend> | null = null;
  private readonly initialization = new AbortController();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly repositoryListeners = new Map<string, vscode.Disposable>();
  private readonly notifications = new SourceControlNotifications((message) => {
    void showOperationError(message, true);
  });

  private generation: vscode.CancellationTokenSource | null = null;
  private generationRepositoryId: string | null = null;
  private preferredRepositoryId: string | null = null;
  private hasSessionPreference = false;
  private disposed = false;
  private publication = 0;
  private readonly refreshCompletion = new RefreshCompletion();
  private refreshGeneration = 0;
  private amendGeneration = 0;
  private readonly readProgress: SourceControlReadProgress;

  constructor(
    storage: vscode.Memento,
    private readonly onState: (state: SourceControlState) => void,
    private readonly generateMessage: typeof generateCommitMessage = generateCommitMessage,
  ) {
    this.model = new SourceControlModel(storage);
    this.readProgress = new SourceControlReadProgress(this.model, () =>
      this.publish(),
    );
    this.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('git')) this.scheduleRefresh();
        if (event.affectsConfiguration('workbench.hover.delay')) this.publish();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() =>
        this.scheduleRefresh(),
      ),
      vscode.extensions.onDidChange(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const id = this.generationRepositoryId;
        const repo = id ? this.model.repositories.get(id) : undefined;

        if (!repo || !event.contentChanges.length) return;
        if (
          repo.checked
            .selected()
            .some((file) =>
              [file.path, file.originalPath].some(
                (path) =>
                  vscode.Uri.joinPath(
                    vscode.Uri.parse(repo.info.rootUri),
                    ...path.split('/'),
                  ).toString() === event.document.uri.toString(),
              ),
            )
        ) {
          this.cancelGeneration();
          this.publish();
        }
      }),
    );
    this.publish();
    void this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.initialization.abort();
    this.refreshGeneration++;
    this.cancelGeneration();
    // Git UI-owned dialogs and queued writes lose their live target on disposal.
    this.model.updateRepositories([]);
    this.notifications.reset();
    this.refreshCompletion.dispose();
    for (const listener of this.repositoryListeners.values())
      listener.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  publish(): void {
    if (this.disposed) return;
    const publication = ++this.publication;
    const state = publicationState(this.model.state());

    const emit = () => {
      if (this.disposed || publication !== this.publication) return;
      this.onState(state);
    };

    const contexts = publishSourceControlContexts(this.model);

    // Show work immediately; editable completion still waits for native menus.
    if (state.busy || state.activity) emit();
    else void contexts.then(emit);
  }

  async handle(
    request: SourceControlRequest,
    nativePrompt = false,
  ): Promise<void> {
    if (this.disposed) return;
    if (this.model.busy) {
      if (request.kind === 'ready') this.publish();

      return;
    }

    try {
      if (isRepositoryAction(request)) {
        await this.write(
          request.repositoryId,
          repositoryActionTitles[request.kind],
          (runtime) =>
            runRepositoryAction({ runtime, model: this.model, request }),
        );

        return;
      }

      switch (request.kind) {
        case 'abort-operation':
          await this.write(
            request.repositoryId,
            'Aborting operation…',
            (runtime) =>
              abortOperation({
                runtime,
                model: this.model,
                id: request.repositoryId,
                token: request.token,
              }),
          );

          return;
        case 'ready':
          this.amendGeneration++;
          this.cancelGeneration();
          if (!this.hasSessionPreference) {
            this.preferredRepositoryId = request.repositoryId;
            this.model.tab = request.tab;
            if (
              request.repositoryId &&
              this.model.repositories.has(request.repositoryId)
            )
              this.model.repositoryId = request.repositoryId;
            this.hasSessionPreference = true;
          }

          this.publish();

          return;
        case 'refresh':
          this.model.error = null;
          this.notifications.reset();
          await this.refresh();

          return;
        case 'tab':
          this.amendGeneration++;
          this.cancelGeneration();
          this.model.tab = request.tab;
          this.hasSessionPreference = true;
          this.publish();

          return;
        case 'repository':
          this.model.requireRepository(request.repositoryId);
          this.amendGeneration++;
          this.cancelGeneration();
          this.model.repositoryId = request.repositoryId;
          this.preferredRepositoryId = request.repositoryId;
          this.hasSessionPreference = true;
          this.publish();

          return;
        case 'reveal-working': {
          const repo = this.model.requireRepository(request.repositoryId);
          const path =
            repo.changes.kind === 'ready'
              ? openedChangePath(
                  vscode.Uri.parse(repo.info.rootUri),
                  repo.changes.items,
                )
              : null;

          if (path) {
            this.model.reveal = {
              repositoryId: repo.info.id,
              path,
              sequence: (this.model.reveal?.sequence ?? 0) + 1,
            };
            this.publish();
          }

          return;
        }

        case 'check': {
          const repo = this.model.requireRepository(request.repositoryId);

          this.model.workingFiles(request.repositoryId, request.paths);
          this.cancelGeneration();
          for (const path of request.paths)
            repo.checked.setFile(path, request.checked);
          this.publish();

          return;
        }

        case 'message':
          this.model.requireRepository(request.repositoryId);
          this.amendGeneration++;
          this.cancelGeneration();
          this.model.setDraft(
            request.repositoryId,
            request.message,
            request.editId,
          );
          this.publish();

          return;
        case 'cancel-generation':
          this.cancelGeneration();
          this.publish();

          return;
        case 'generate':
          await this.generate(request.repositoryId);

          return;
        case 'amend':
          await this.amend(request.repositoryId, request.enabled);

          return;
        case 'commit':
        case 'stash':
        case 'stash-silently':
        case 'commit-selected':
        case 'stash-selected': {
          const kind =
            request.kind === 'commit-selected'
              ? 'commit'
              : request.kind === 'stash-selected'
                ? 'stash'
                : request.kind;

          await this.write(
            request.repositoryId,
            kind === 'commit'
              ? this.model.requireRepository(request.repositoryId).commitMode
                  .kind === 'amend'
                ? 'Amending last commit…'
                : 'Committing checked files…'
              : 'Stashing checked files…',
            (runtime) =>
              writeChanges({
                runtime,
                model: this.model,
                id: request.repositoryId,
                kind,
                nativePrompt,
                selection:
                  'paths' in request
                    ? { kind: 'selected', paths: request.paths }
                    : { kind: 'checked' },
                publish: () => this.publish(),
              }),
          );

          return;
        }

        case 'open-working':
          await this.openWorking(request);

          return;
        case 'copy-paths': {
          const runtime = await this.initialize();

          requireLiveRepository(runtime, this.model, request.repositoryId);
          await vscode.env.clipboard.writeText(
            [...new Set(request.paths)].join('\n'),
          );

          return;
        }

        case 'resolve-conflicts':
        case 'reveal-in-os':
        case 'reveal-in-explorer': {
          const runtime = await this.initialize();

          await inspectWorkingFiles({ runtime, model: this.model, request });

          return;
        }

        case 'delete-files':
        case 'accept-current':
        case 'accept-incoming':
        case 'stage-files':
        case 'unstage-files':
          await this.write(
            request.repositoryId,
            request.kind === 'delete-files'
              ? 'Moving files to Trash…'
              : request.kind === 'stage-files'
                ? 'Staging changes…'
                : request.kind === 'unstage-files'
                  ? 'Unstaging changes…'
                  : 'Resolving selected conflicts…',
            (runtime) =>
              writeWorkingFiles({ runtime, model: this.model, request }),
          );

          return;

        case 'rollback':
          await this.write(
            request.repositoryId,
            'Rolling back changes…',
            (runtime) =>
              rollbackChanges({
                runtime,
                model: this.model,
                id: request.repositoryId,
                paths: request.paths,
              }),
          );

          return;
        case 'discard-working':
          await this.write(
            request.repositoryId,
            'Discarding changes…',
            (runtime) =>
              discardWorking({
                runtime,
                model: this.model,
                id: request.repositoryId,
                path: request.path,
              }),
          );

          return;
        case 'load-stash':
          await this.loadStash(request.repositoryId, request.sha);

          return;
        case 'open-stash-file':
          await this.openStashFile(request);

          return;
        case 'open-stash-files':
          for (const file of request.files)
            await this.openStashFile(
              {
                kind: 'open-stash-file',
                repositoryId: request.repositoryId,
                sha: request.sha,
                file,
              },
              request.files.length === 1,
            );

          return;
        case 'restore-stash':
        case 'restore-stash-files':
        case 'delete-stash':
        case 'delete-stash-files':
        case 'rename-stash':
          await this.write(
            request.repositoryId,
            savedWriteDescription(request),
            (runtime) => writeSaved({ runtime, model: this.model, request }),
          );

          return;
      }
    } catch (error) {
      if (this.disposed) return;
      this.model.error = errorMessage(error);
      this.publish();
      await showOperationError(this.model.error, true);
    }
  }

  refresh(): Promise<void> {
    return this.refreshCompletion.run(() => this.refreshChanges());
  }

  private async refreshChanges(): Promise<void> {
    const epoch = ++this.refreshGeneration;
    const generatingId = this.generationRepositoryId;
    const identity = generatingId
      ? this.model.selectionIdentity(generatingId)
      : null;

    try {
      const runtime = await this.initialize();

      if (this.disposed || epoch !== this.refreshGeneration) return;
      if (
        !vscode.workspace.isTrusted ||
        !vscode.workspace.getConfiguration('git').get<boolean>('enabled', true)
      )
        throw new Error(
          'Enable Git and trust this workspace to load changes and stashes.',
        );
      const infos = runtime.repositories();
      const ids = new Set(infos.map((info) => info.id));

      this.notifications.connection(null);
      this.notifications.retainRepositories(ids);

      for (const [id, listener] of this.repositoryListeners)
        if (!ids.has(id)) {
          listener.dispose();
          this.repositoryListeners.delete(id);
        }

      for (const info of infos)
        if (!this.repositoryListeners.has(info.id))
          this.repositoryListeners.set(
            info.id,
            runtime.subscribe(info.id, () => this.scheduleRefresh()),
          );
      this.model.updateRepositories(infos);
      this.readProgress.retain(ids);
      this.readProgress.begin();
      if (this.preferredRepositoryId && ids.has(this.preferredRepositoryId))
        this.model.repositoryId = this.preferredRepositoryId;
      this.publish();
      await refreshRepositories({
        runtime,
        model: this.model,
        infos,
        notifications: this.notifications,
        isCurrent: () => !this.disposed && epoch === this.refreshGeneration,
        settled: (id, source) => this.readProgress.settled(id, source),
        publish: () => {
          if (
            generatingId &&
            identity !== this.model.selectionIdentity(generatingId)
          )
            this.cancelGeneration();
          this.publish();
        },
      });
    } catch (error) {
      if (this.disposed || epoch !== this.refreshGeneration) return;
      this.model.error = errorMessage(error);
      this.model.updateRepositories([]);
      this.readProgress.finish();
      this.notifications.connection(this.model.error);
    }

    if (!this.disposed && epoch === this.refreshGeneration) {
      if (
        generatingId &&
        identity !== this.model.selectionIdentity(generatingId)
      )
        this.cancelGeneration();
      this.publish();
    }
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
    this.refreshGeneration++;
    if (this.model.busy) return;
    this.refreshCompletion.schedule(() => this.refreshChanges());
  }

  private initialize(): Promise<SourceControlBackend> {
    if (this.runtime) return Promise.resolve(this.runtime);
    if (this.initializing) return this.initializing;
    this.initializing = createSourceControlBackend(this.initialization.signal)
      .then((runtime) => {
        if (!this.disposed) {
          this.runtime = runtime;
          this.subscriptions.push(
            runtime,
            runtime.subscribeRepositories(() => this.scheduleRefresh()),
          );
        } else runtime.dispose();

        return runtime;
      })
      .finally(() => {
        this.initializing = null;
      });

    return this.initializing;
  }

  private async amend(id: string, enabled: boolean): Promise<void> {
    const generation = ++this.amendGeneration;
    const activity = {
      repositoryId: id,
      title: enabled ? 'Loading last commit…' : 'Restoring commit message…',
    };

    this.cancelGeneration();
    this.model.activity = activity;
    this.publish();
    const isCurrent = () =>
      !this.disposed &&
      generation === this.amendGeneration &&
      this.model.repositoryId === id;

    try {
      const runtime = await this.initialize();

      await toggleAmend({ runtime, model: this.model, id, enabled, isCurrent });
    } catch (error) {
      if (isCurrent()) throw error;
    } finally {
      if (this.model.activity === activity) {
        this.model.activity = null;
        this.publish();
      }
    }
  }

  private async write(
    id: string,
    title: string,
    action: (runtime: SourceControlBackend) => Promise<void>,
  ): Promise<void> {
    await runSourceControlWrite({
      id,
      title,
      action,
      model: this.model,
      reads: this.readProgress,
      beforeWrite: () => {
        this.amendGeneration++;
        this.refreshGeneration++;
        this.cancelGeneration();
      },
      initialize: () => this.initialize(),
      closed: () => this.disposed,
      publish: () => this.publish(),
      refresh: () => this.refresh(),
    });
  }

  private cancelGeneration(): void {
    this.generation?.cancel();
    this.generation?.dispose();
    this.generation = null;
    this.generationRepositoryId = null;
    this.model.generating = false;
  }

  private async generate(id: string): Promise<void> {
    if (this.generation) return;
    this.amendGeneration++;
    const files = this.model.selectedFiles(id);
    const identity = this.model.selectionIdentity(id);
    const source = new vscode.CancellationTokenSource();

    this.generation = source;
    this.generationRepositoryId = id;
    this.model.generating = true;
    this.model.error = null;
    this.publish();
    try {
      const runtime = await this.initialize();

      requireLiveRepository(runtime, this.model, id);
      const root = runtime.root(id);

      if (source.token.isCancellationRequested || this.disposed) return;
      if (!(await saveSelectedDocuments(root, files))) return;
      if (
        source.token.isCancellationRequested ||
        this.disposed ||
        this.generation !== source ||
        identity !== this.model.selectionIdentity(id)
      )
        return;
      if (dirtySelectedDocuments(root, files).length)
        throw new Error(
          'Checked files have unsaved edits. Save them before generating a message.',
        );
      const message = await this.generateMessage(
        runtime,
        id,
        files,
        source.token,
      );

      if (
        this.disposed ||
        source.token.isCancellationRequested ||
        this.generation !== source ||
        identity !== this.model.selectionIdentity(id) ||
        dirtySelectedDocuments(root, files).length
      )
        return;
      this.model.setDraft(id, message);
    } catch (error) {
      if (
        !source.token.isCancellationRequested &&
        !(error instanceof vscode.CancellationError)
      )
        throw error;
    } finally {
      if (this.generation === source) {
        source.dispose();
        this.generation = null;
        this.generationRepositoryId = null;
        this.model.generating = false;
        this.publish();
      }
    }
  }

  private async loadStash(id: string, sha: string): Promise<void> {
    const runtime = await this.initialize();

    requireLiveRepository(runtime, this.model, id);
    const stash = this.model.requireStash(id, sha);

    if (stash.files?.kind === 'ready' || stash.files?.kind === 'loading')
      return;
    stash.files = { kind: 'loading' };
    this.publish();
    const files = await loaded(runtime.stashFiles(id, stash));

    if (this.disposed) return;
    const current = this.model.repositories.get(id);
    const target =
      current?.stashes.kind === 'ready'
        ? current.stashes.items.find((item) => item.sha === sha)
        : undefined;

    if (target) {
      target.files = files;
      this.notifications.load(
        id,
        `stash:${sha}`,
        `Stash ${stash.message || stash.selector}`,
        files,
      );
      this.publish();
    }
  }

  private async openWorking(
    request: Extract<SourceControlRequest, { kind: 'open-working' }>,
    preview = true,
  ): Promise<void> {
    const runtime = await this.initialize();

    requireLiveRepository(runtime, this.model, request.repositoryId);
    const file = this.model.workingFiles(
      request.repositoryId,
      [request.path],
      request.index ? 'index' : 'working',
    )[0];

    if (!file) return;
    if (/U|AA|DD/.test(file.status)) {
      await runtime.status(request.repositoryId);
      requireLiveRepository(runtime, this.model, request.repositoryId);
      await vscode.commands.executeCommand(
        'git.openChange',
        vscode.Uri.joinPath(
          runtime.root(request.repositoryId),
          ...file.path.split('/'),
        ),
      );

      return;
    }

    await openSourceControlDiff(
      await runtime.workingComparison(
        request.repositoryId,
        file,
        request.index,
      ),
      `${file.path} (${request.index ? 'HEAD ↔ staged' : 'staged ↔ working'})`,
      preview,
    );
  }

  private async openStashFile(
    request: Extract<SourceControlRequest, { kind: 'open-stash-file' }>,
    preview = true,
  ): Promise<void> {
    const runtime = await this.initialize();

    requireLiveRepository(runtime, this.model, request.repositoryId);
    const file = this.model.stashFiles(request.repositoryId, request.sha, [
      request.file,
    ])[0];

    if (!file) return;
    await openSourceControlDiff(
      runtime.stashComparison(request.repositoryId, file),
      `${file.path} (${file.snapshot} · ${request.sha.slice(0, 8)})`,
      preview,
    );
  }
}
