import * as vscode from 'vscode';

import type { GitApiAccess, GitCommit } from '../git/api';
import type { BlameLine, BlameQuery, BlameResult } from '../git/blame-model';
import { resolveBlameDocument } from './blame-document';
import { createBlameHover, formatBlameLabel } from './blame-presentation';
import { matchesBlameText } from './blame-snapshot';
import { showOperationError, showOperationInfo } from './operation-feedback';

interface Snapshot {
  access: GitApiAccess;
  query: BlameQuery;
  version: number;
  lines: readonly BlameLine[];
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
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor('git.blame.editorDecorationForeground'),
      width: '25ch',
      margin: '0 1.5ch 0 0',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  private readonly sessions = new Map<vscode.TextEditor, Session>();
  private readonly immutable = new Map<string, readonly BlameLine[]>();
  private readonly commits = new Map<string, Promise<GitCommit>>();
  private readonly listeners: vscode.Disposable[];
  private disposed = false;

  constructor(
    private readonly options: {
      getAccess: () => Promise<GitApiAccess>;
      readBlame: (
        query: BlameQuery,
        signal?: AbortSignal,
      ) => Promise<BlameResult>;
    },
  ) {
    this.listeners = [
      vscode.workspace.onDidChangeTextDocument(({ document }) => {
        for (const session of this.sessions.values())
          if (session.editor.document === document) this.schedule(session);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        for (const session of this.sessions.values())
          if (session.editor.document === document) this.close(session.editor);
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges(({ textEditor }) => {
        const session = this.sessions.get(textEditor);

        if (session) this.render(session);
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
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('git.enabled')) {
          for (const editor of this.sessions.keys()) this.close(editor);
        } else if (event.affectsConfiguration('git.blame.ignoreWhitespace')) {
          this.immutable.clear();
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

  private cache(key: string, lines: readonly BlameLine[]): void {
    if (lines.length > 100_000) return;
    this.immutable.delete(key);
    this.immutable.set(key, lines);
    while (
      this.immutable.size > 8 ||
      [...this.immutable.values()].reduce(
        (sum, value) => sum + value.length,
        0,
      ) > 100_000
    ) {
      const oldest = this.immutable.keys().next().value;

      if (oldest === undefined) break;
      this.immutable.delete(oldest);
    }
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
          for (const key of this.immutable.keys())
            if (key.startsWith(query.repositoryId + '\0'))
              this.immutable.delete(key);
          this.schedule(session);
        });
        const closed = access.api.onDidCloseRepository((value) => {
          if (value.rootUri.toString() === query.repositoryId)
            this.close(session.editor);
        });

        session.repository = vscode.Disposable.from(status, closed);
      }

      const key =
        query.source.kind === 'revision'
          ? `${query.repositoryId}\0${query.source.sha}\0${query.source.path}\0${query.ignoreWhitespace}`
          : null;
      const cached = key ? this.immutable.get(key) : undefined;
      const result = cached
        ? { kind: 'blame' as const, lines: cached }
        : await this.options.readBlame(query, abort.signal);

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
      if (key) this.cache(key, result.lines);
      session.snapshot = { access, query, version, lines: result.lines };
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
    const visible = new Set<number>();

    for (const range of session.editor.visibleRanges)
      for (let index = range.start.line; index <= range.end.line; index++)
        visible.add(index);
    for (const index of visible) {
      const line = snapshot.lines[index];

      if (!line) continue;
      decorations.push({
        range: new vscode.Range(index, 0, index, 0),
        renderOptions: { before: { contentText: formatBlameLabel(line) } },
      });
    }

    session.editor.setDecorations(this.decoration, decorations);
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | null> {
    if (position.character !== 0 || token.isCancellationRequested) return null;
    const session = [...this.sessions.values()].find(
      (candidate) =>
        candidate.editor.document === document &&
        candidate.snapshot?.version === document.version,
    );
    const snapshot = session?.snapshot;
    const line = snapshot?.lines[position.line];

    if (!session || !snapshot || !line) return null;
    let commit: GitCommit | null = null;

    if (line.kind === 'committed') {
      const key = `${snapshot.query.repositoryId}\0${line.sha}`;
      let read = this.commits.get(key);

      if (!read) {
        read = snapshot.access
          .repository(snapshot.query.repositoryId)
          .getCommit(line.sha);
        this.commits.set(key, read);
        if (this.commits.size > 64) {
          const oldest = this.commits.keys().next().value;

          if (oldest !== undefined) this.commits.delete(oldest);
        }
      }

      try {
        commit = await read;
      } catch (error) {
        this.commits.delete(key);
        if (token.isCancellationRequested || session.snapshot !== snapshot)
          return null;
        throw error;
      }
    }

    if (
      token.isCancellationRequested ||
      session.snapshot !== snapshot ||
      document.version !== snapshot.version ||
      !this.sessions.has(session.editor)
    )
      return null;

    return new vscode.Hover(
      createBlameHover({ line, documentUri: document.uri, commit }),
      new vscode.Range(position.line, 0, position.line, 1),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const editor of this.sessions.keys()) this.close(editor);
    for (const listener of this.listeners) listener.dispose();
    this.decoration.dispose();
    this.immutable.clear();
    this.commits.clear();
  }
}
