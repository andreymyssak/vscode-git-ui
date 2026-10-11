import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import type { GitApiAccess, GitCommit } from '../git/api';
import type { BlameLine, BlameQuery, BlameResult } from '../git/blame-model';
import { BlameReadCache } from './blame-cache';
import { resolveBlameDocument } from './blame-document';
import { createBlameHover, formatBlameLabel } from './blame-presentation';
import { matchesBlameText } from './blame-snapshot';
import { showOperationError, showOperationInfo } from './operation-feedback';

interface Snapshot {
  id: string;
  access: GitApiAccess;
  query: BlameQuery;
  version: number;
  lines: readonly BlameLine[];
  width: number;
  oldest: number;
  newest: number;
}

interface Session {
  editor: vscode.TextEditor;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  snapshot: Snapshot | null;
  repository: vscode.Disposable | null;
  repositoryId: string | null;
}

const cancelled = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError';

export class BlameAnnotations implements vscode.Disposable {
  private readonly enabledChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeEnabled = this.enabledChanged.event;
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    before: {
      margin: '0 0.8em 0 0',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  private readonly sessions = new Map<vscode.TextEditor, Session>();
  private readonly cache: BlameReadCache;
  private readonly listeners: vscode.Disposable[];
  private disposed = false;

  constructor(
    private readonly options: {
      getAccess: () => Promise<GitApiAccess>;
      readBlame: (
        query: BlameQuery,
        signal?: AbortSignal,
      ) => Promise<BlameResult>;
      openCommit: (
        target: { documentUri: vscode.Uri; sha: string; filePath: string },
        isCurrent: () => boolean,
      ) => Promise<void>;
    },
  ) {
    this.cache = new BlameReadCache(options.readBlame);
    this.listeners = [
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const session = this.sessions.get(event.textEditor);
        const selection = event.selections[0];
        const snapshot = session?.snapshot;
        const line = snapshot?.lines[selection?.active.line ?? -1];

        if (!session || !snapshot || !selection) return;
        if (
          event.kind === vscode.TextEditorSelectionChangeKind.Mouse &&
          selection.isEmpty &&
          selection.active.character === 0 &&
          line?.kind === 'committed'
        ) {
          const current = () =>
            this.liveSnapshot(session, snapshot) &&
            vscode.window.visibleTextEditors.includes(session.editor);

          void this.options
            .openCommit(
              {
                documentUri: session.editor.document.uri,
                sha: line.sha,
                filePath: line.originalPath,
              },
              current,
            )
            .catch((error: unknown) => {
              if (current() && !cancelled(error))
                void showOperationError(
                  error instanceof Error ? error.message : String(error),
                );
            });
        }
      }),
      vscode.workspace.onDidChangeTextDocument(({ document }) => {
        for (const session of this.sessions.values())
          if (session.editor.document === document) this.schedule(session);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        for (const session of this.sessions.values())
          if (session.editor.document === document) this.close(session.editor);
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          if (this.sessions.has(editor)) continue;
          const previous = [...this.sessions.values()].find(
            (session) =>
              !editors.includes(session.editor) &&
              session.editor.document === editor.document &&
              session.editor.viewColumn === editor.viewColumn,
          );

          if (!previous) continue;
          this.sessions.delete(previous.editor);
          previous.editor = editor;
          this.sessions.set(editor, previous);
          this.render(previous);
          this.enabledChanged.fire();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('git.enabled')) {
          for (const editor of this.sessions.keys()) this.close(editor);
        } else if (event.affectsConfiguration('git.blame.ignoreWhitespace')) {
          this.cache.invalidate();
          for (const session of this.sessions.values()) this.schedule(session);
        }
      }),
    ];
  }

  async annotate(editor: vscode.TextEditor): Promise<void> {
    if (this.disposed) return;
    const existing = this.sessions.get(editor);

    if (existing) return this.refresh(existing, true);
    const session: Session = {
      editor,
      abort: new AbortController(),
      timer: null,
      snapshot: null,
      repository: null,
      repositoryId: null,
    };

    this.sessions.set(editor, session);
    this.enabledChanged.fire();
    try {
      await this.refresh(session, true);
    } catch (error) {
      this.close(editor);
      throw error;
    }
  }

  close(editor: vscode.TextEditor): void {
    const session = this.sessions.get(editor);

    if (!session) return;
    this.sessions.delete(editor);
    session.abort.abort();
    if (session.timer) clearTimeout(session.timer);
    session.repository?.dispose();
    session.snapshot = null;
    editor.setDecorations(this.decoration, []);
    this.enabledChanged.fire();
  }

  isEnabled(editor: vscode.TextEditor): boolean {
    return this.sessions.has(editor);
  }

  private schedule(session: Session): void {
    session.abort.abort();
    session.snapshot = null;
    session.editor.setDecorations(this.decoration, []);
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      session.timer = null;
      void this.refresh(session, false);
    }, 150);
  }

  private current(
    session: Session,
    abort: AbortController,
    version: number,
  ): boolean {
    return (
      !this.disposed &&
      !abort.signal.aborted &&
      this.sessions.get(session.editor) === session &&
      session.editor.document.version === version &&
      !session.editor.document.isClosed
    );
  }

  private async refresh(session: Session, interactive: boolean): Promise<void> {
    session.abort.abort();
    const abort = new AbortController();

    session.abort = abort;
    const document = session.editor.document;
    const version = document.version;
    const text = document.getText();

    try {
      const access = await this.options.getAccess();

      if (!this.current(session, abort, version)) return;
      const resolved = await resolveBlameDocument(access, document);

      if (!this.current(session, abort, version)) return;
      if (resolved.kind !== 'ready') {
        if (resolved.kind === 'unsupported') throw new Error(resolved.message);
        this.close(session.editor);
        if (interactive)
          showOperationInfo('This file has no committed history to annotate.');

        return;
      }

      const { query } = resolved;

      if (session.repositoryId !== query.repositoryId) {
        session.repository?.dispose();
        session.repositoryId = query.repositoryId;
        const repository = access.repository(query.repositoryId);
        const status = repository.state.onDidChange(() => {
          if (query.source.kind === 'contents') this.schedule(session);
        });
        const closed = access.api.onDidCloseRepository((value) => {
          if (value.rootUri.toString() === query.repositoryId) {
            this.cache.invalidate(query.repositoryId);
            this.close(session.editor);
          }
        });

        session.repository = vscode.Disposable.from(status, closed);
      }

      const result = await this.cache.read(query, abort.signal);

      if (!this.current(session, abort, version)) return;
      if (result.kind === 'no-history') {
        this.close(session.editor);
        if (interactive)
          showOperationInfo('This file has no committed history to annotate.');

        return;
      }

      if (!matchesBlameText(result.lines, text))
        throw new Error(
          'The displayed file does not match its Git blame snapshot.',
        );
      let width = 1;
      let oldest = Infinity;
      let newest = -Infinity;

      for (const line of result.lines) {
        width = Math.max(width, Array.from(formatBlameLabel(line)).length);
        if (line.kind === 'committed') {
          const time = Date.parse(line.authorDate);

          oldest = Math.min(oldest, time);
          newest = Math.max(newest, time);
        }
      }

      session.snapshot = {
        id: randomUUID(),
        access,
        query,
        version,
        lines: result.lines,
        width,
        oldest,
        newest,
      };
      this.render(session);
    } catch (error) {
      if (cancelled(error) || !this.current(session, abort, version)) return;
      if (interactive) throw error;
      this.close(session.editor);
      void showOperationError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private render(session: Session): void {
    const snapshot = session.snapshot;

    if (!snapshot || snapshot.version !== session.editor.document.version)
      return;
    const decorations: vscode.DecorationOptions[] = [];
    const { width, oldest, newest } = snapshot;

    // Include offscreen headings and clipped edge rows so layout stays
    // stable on scroll. Cursor movement and navigation leave colors unchanged.
    for (const [index, line] of snapshot.lines.entries()) {
      decorations.push({
        range: new vscode.Range(index, 0, index, 0),
        renderOptions: {
          before: {
            contentText: formatBlameLabel(line).padEnd(width),
            width: `${width + 1}ch`,
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            textDecoration: `none; border-right: 1px solid var(--vscode-panel-border); padding-right: 0.6em; white-space: pre; overflow: hidden; text-overflow: ellipsis; vertical-align: top; cursor: ${line.kind === 'committed' ? 'pointer' : 'text'}`,
            backgroundColor:
              line.kind === 'committed'
                ? `hsla(${210 - 170 * (newest === oldest ? 0 : (Date.parse(line.authorDate) - oldest) / (newest - oldest))}, 65%, 55%, 0.14)`
                : new vscode.ThemeColor('editor.lineHighlightBackground'),
          },
        },
      });
    }

    session.editor.setDecorations(this.decoration, decorations);
  }

  private liveSnapshot(session: Session, snapshot: Snapshot): boolean {
    return (
      !this.disposed &&
      session.snapshot === snapshot &&
      this.sessions.get(session.editor) === session &&
      session.editor.document.version === snapshot.version &&
      !session.editor.document.isClosed
    );
  }

  hoverCurrent(snapshotId: string): () => boolean {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.snapshot?.id === snapshotId,
    );
    const snapshot = session?.snapshot;

    if (!session || !snapshot) return () => false;

    return () =>
      this.liveSnapshot(session, snapshot) &&
      vscode.window.visibleTextEditors.includes(session.editor);
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | null> {
    if (position.character !== 0 || token.isCancellationRequested) return null;
    const sessions = [...this.sessions.values()].filter(
      (candidate) =>
        candidate.editor.document === document &&
        candidate.snapshot?.version === document.version &&
        vscode.window.visibleTextEditors.includes(candidate.editor),
    );
    const session =
      sessions.find(
        (candidate) => candidate.editor === vscode.window.activeTextEditor,
      ) ?? sessions[0];
    const snapshot = session?.snapshot;
    const line = snapshot?.lines[position.line];

    if (!session || !snapshot || !line) return null;
    let commit: GitCommit | null = null;

    if (line.kind === 'committed') {
      try {
        commit = await this.cache.commit(
          snapshot.access,
          snapshot.query.repositoryId,
          line.sha,
        );
      } catch (error) {
        if (
          token.isCancellationRequested ||
          !this.liveSnapshot(session, snapshot)
        )
          return null;
        throw error;
      }
    }

    if (token.isCancellationRequested || !this.liveSnapshot(session, snapshot))
      return null;

    return new vscode.Hover(
      createBlameHover({
        line,
        documentUri: document.uri,
        commit,
        snapshotId: snapshot.id,
      }),
      new vscode.Range(position.line, 0, position.line, 1),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const editor of this.sessions.keys()) this.close(editor);
    for (const listener of this.listeners) listener.dispose();
    this.decoration.dispose();
    this.cache.dispose();
    this.enabledChanged.dispose();
  }
}
