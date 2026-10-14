import * as vscode from 'vscode';

import type {
  Loaded,
  SourceControlOperation,
  SourceControlRequest,
  SourceControlState,
  Stash,
  WorkingFile,
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
import { formatPathLabel } from '../native/path-label';
import { openSourceControlDiff } from '../native/source-control-diffs';
import { abortOperation } from './abort';
import { discardWorking } from './discard';
import { inspectWorkingFiles, writeWorkingFiles } from './file-actions';
import { toggleAmend } from './message-tools';
import { SourceControlModel } from './model';
import { SourceControlNotifications } from './notifications';
import { rollbackChanges } from './rollback';
import { savedWriteDescription, writeSaved } from './saved-writes';
import { requireLiveRepository, writeChanges } from './writes';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loaded<T>(work: Promise<T[]>): Promise<Loaded<T>> {
  try {
    return { kind: 'ready', items: await work };
  } catch (error) {
    return { kind: 'error', message: errorMessage(error) };
  }
}

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
  private refreshGeneration = 0;
  private amendGeneration = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    storage: vscode.Memento,
    private readonly onState: (state: SourceControlState) => void,
    private readonly generateMessage: typeof generateCommitMessage = generateCommitMessage,
  ) {
    this.model = new SourceControlModel(storage);
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
    // Pending dialogs and queued writes must lose their live target on disposal.
    this.model.updateRepositories([]);
    this.notifications.reset();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const listener of this.repositoryListeners.values())
      listener.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  publish(): void {
    if (this.disposed) return;
    const checked = this.model.repositoryId
      ? (this.model.repositories
          .get(this.model.repositoryId)
          ?.checked.selected().length ?? 0)
      : 0;

    void Promise.resolve(
      vscode.commands.executeCommand(
        'setContext',
        'gitUI.changesHasChecked',
        checked > 0,
      ),
    ).catch(() => undefined);
    void Promise.resolve(
      vscode.commands.executeCommand(
        'setContext',
        'gitUI.sourceControlBusy',
        this.model.busy,
      ),
    ).catch(() => undefined);
    const state = this.model.state();

    this.onState({
      ...state,
      hoverDelay: vscode.workspace
        .getConfiguration('workbench')
        .get<number>('hover.delay', process.platform === 'darwin' ? 1500 : 500),
      repositories: state.repositories.map((repository) => ({
        ...repository,
        pathLabel: {
          root: formatPathLabel({
            path: vscode.Uri.parse(repository.info.rootUri).fsPath,
          }),
          separator: process.platform === 'win32' ? '\\' : '/',
        },
      })),
    });
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
              ? 'Committing checked files…'
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

  async refresh(): Promise<void> {
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
      if (this.preferredRepositoryId && ids.has(this.preferredRepositoryId))
        this.model.repositoryId = this.preferredRepositoryId;
      this.publish();
      const results = await Promise.all(
        infos.map(async (info) => {
          const [changes, stashes, operation] = await Promise.all([
            loaded<WorkingFile>(runtime.workingChanges(info.id)),
            loaded<Stash>(runtime.stashes(info.id)),
            loaded<SourceControlOperation>(runtime.operation(info.id)),
          ]);

          return { id: info.id, changes, stashes, operation };
        }),
      );

      if (this.disposed || epoch !== this.refreshGeneration) return;
      for (const result of results) {
        this.model.requireRepository(result.id).operation = result.operation;
        this.model.updateChanges(result.id, result.changes);
        this.model.updateStashes(result.id, result.stashes);
        const label = this.model.requireRepository(result.id).info.label;

        this.notifications.load(
          result.id,
          'changes',
          `Changes in ${label}`,
          result.changes,
        );
        this.notifications.load(
          result.id,
          'stashes',
          `Stashes in ${label}`,
          result.stashes,
        );
      }
    } catch (error) {
      if (this.disposed || epoch !== this.refreshGeneration) return;
      this.model.error = errorMessage(error);
      this.model.updateRepositories([]);
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
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 100);
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

    this.cancelGeneration();
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
      if (isCurrent()) this.publish();
    }
  }

  private async write(
    id: string,
    title: string,
    action: (runtime: SourceControlBackend) => Promise<void>,
  ): Promise<void> {
    if (this.model.busy) return;
    this.amendGeneration++;
    // Acquire before any await, including trust, repository lookup and save dialogs.
    this.model.busy = true;
    this.cancelGeneration();
    this.model.error = null;
    this.publish();
    let runtime: SourceControlBackend | null = null;

    try {
      runtime = await this.initialize();
      if (this.disposed) return;
      requireLiveRepository(runtime, this.model, id);
      const current = runtime;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title },
        () => action(current),
      );
    } finally {
      if (!this.disposed) {
        try {
          await runtime?.status(id);
        } catch {
          // A repository can close while its action or save dialog is open.
        }

        await this.refresh();
      }

      // Native menus must be enabled before the webview exposes editable rows.
      await Promise.resolve(
        vscode.commands.executeCommand(
          'setContext',
          'gitUI.sourceControlBusy',
          false,
        ),
      ).catch(() => undefined);
      this.model.busy = false;
      this.publish();
    }
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
