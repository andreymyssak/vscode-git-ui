import * as vscode from 'vscode';
import { z } from 'zod';

import { commandId } from '../../shared/extension-identity';
import { createGitAdapter, type GitAdapter } from '../git/adapter';
import { getGitApi } from '../git/api';
import type { CommitJump } from '../panel/commit-jump';
import { readWithCancellation } from '../read-cancellation';
import { BlameAnnotations } from './blame-annotations';
import { blameFileUri } from './blame-document';
import { showOperationError } from './operation-feedback';

const menuArgument = z.object({
  uri: z.custom<vscode.Uri>((value) => value instanceof vscode.Uri),
  lineNumber: z.number().int().positive(),
});
const commitArgument = z.object({
  documentUri: z.string().min(1),
  sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
  filePath: z.string().min(1).optional(),
  snapshotId: z.string().uuid().optional(),
});
const cancelled = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError';

function commandEditor(value: unknown): vscode.TextEditor {
  let uri: vscode.Uri | undefined;
  let lineNumber: number | undefined;

  if (value instanceof vscode.Uri) uri = value;
  else if (value !== undefined) {
    const parsed = menuArgument.safeParse(value);

    if (!parsed.success)
      throw new Error('Select a line in an open text editor to annotate.');
    uri = parsed.data.uri;
    lineNumber = parsed.data.lineNumber;
  }

  const active = vscode.window.activeTextEditor;
  const editor = !uri
    ? active
    : active?.document.uri.toString() === uri.toString()
      ? active
      : vscode.window.visibleTextEditors.find(
          (candidate) => candidate.document.uri.toString() === uri.toString(),
        );

  if (
    !editor ||
    (lineNumber !== undefined && lineNumber > editor.document.lineCount)
  )
    throw new Error('Select a line in an open text editor to annotate.');

  return editor;
}

export function registerBlame(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  options: {
    revealCommit(target: CommitJump, isCurrent?: () => boolean): Promise<void>;
  },
): void {
  let annotations: BlameAnnotations | null = null;
  let adapter: Promise<GitAdapter> | null = null;
  let adapterOwner: AbortController | null = null;
  const lifetime = new AbortController();
  let disposed = false;
  let commitRequest = 0;
  const updateEnabled = () => {
    const editor = vscode.window.activeTextEditor;

    void vscode.commands.executeCommand(
      'setContext',
      commandId('blame-enabled'),
      Boolean(editor && annotations?.isEnabled(editor)),
    );
  };

  const releaseAdapter = () => {
    const previous = adapter;

    adapterOwner?.abort();
    adapterOwner = null;
    adapter = null;
    void previous?.then(
      (value) => value.dispose(),
      () => {},
    );
  };

  const readAdapter = async () => {
    if (!adapter) {
      adapterOwner = new AbortController();
      const pending = createGitAdapter(
        undefined,
        undefined,
        adapterOwner.signal,
      ).catch((error: unknown) => {
        if (adapter === pending) {
          adapter = null;
          adapterOwner = null;
        }

        throw error;
      });

      adapter = pending;
    }

    const current = await adapter;

    if (disposed) {
      current.dispose();
      throw new DOMException('Blame was closed.', 'AbortError');
    }

    return current;
  };

  const integration = () => {
    if (!annotations) {
      annotations = new BlameAnnotations({
        getAccess: getGitApi,
        readBlame: async (query, signal) =>
          (await readWithCancellation(readAdapter, signal)).blame(
            query,
            signal,
          ),
        openCommit: async (target, isCurrent) => {
          await openCommit(
            {
              documentUri: target.documentUri.toString(),
              sha: target.sha,
              filePath: target.filePath,
            },
            isCurrent,
          );
        },
      });
      context.subscriptions.push(annotations.onDidChangeEnabled(updateEnabled));
    }

    return annotations;
  };

  const run = async (
    work: () => void | Promise<void>,
    isCurrent = () => !disposed,
  ): Promise<boolean> => {
    try {
      await getGitApi(lifetime.signal);
      if (!isCurrent()) return false;
      await work();

      return isCurrent();
    } catch (error) {
      if (isCurrent() && !cancelled(error))
        await showOperationError(
          error instanceof Error ? error.message : String(error),
        );

      return false;
    } finally {
      updateEnabled();
    }
  };

  const openCommit = (
    value: unknown,
    sourceCurrent?: () => boolean,
  ): Promise<boolean> => {
    const request = ++commitRequest;
    const parsed = commitArgument.safeParse(value);
    const source =
      sourceCurrent ??
      (parsed.success && parsed.data.snapshotId
        ? (annotations?.hoverCurrent(parsed.data.snapshotId) ?? (() => false))
        : () => true);
    const isCurrent = () => !disposed && request === commitRequest && source();

    return run(async () => {
      if (!parsed.success)
        throw new Error('This blame commit link is invalid.');
      const uri = vscode.Uri.parse(parsed.data.documentUri, true);
      const file = blameFileUri(uri);

      if (!file) throw new Error('This blame document is not a Git file.');
      const access = await getGitApi(lifetime.signal);

      if (!isCurrent()) return;
      const found = access.api.getRepository(file);

      if (!found) throw new Error('The source repository is no longer open.');
      const repositoryId = found.rootUri.toString();

      await access.repository(repositoryId).getCommit(parsed.data.sha);
      if (!isCurrent()) return;
      access.repository(repositoryId);
      await options.revealCommit(
        {
          repositoryId,
          sha: parsed.data.sha,
          ...(parsed.data.filePath === undefined
            ? {}
            : { filePath: parsed.data.filePath }),
        },
        isCurrent,
      );
    }, isCurrent);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      commandId('annotate-blame'),
      (value: unknown) =>
        run(() => integration().annotate(commandEditor(value))),
    ),
    vscode.commands.registerCommand(
      commandId('close-blame'),
      (value: unknown) => run(() => annotations?.close(commandEditor(value))),
    ),
    vscode.commands.registerCommand(
      commandId('open-current-blame-commit'),
      (value: unknown) =>
        run(async () => {
          const editor = commandEditor(value);
          const parsed = menuArgument.safeParse(value);

          if (!annotations)
            throw new Error(
              'Annotate this file before opening its line commit.',
            );
          await annotations.openCurrentCommit(
            editor,
            parsed.success
              ? parsed.data.lineNumber - 1
              : editor.selection.active.line,
          );
        }),
    ),
    vscode.languages.registerHoverProvider(
      [{ scheme: 'file' }, { scheme: 'git' }],
      {
        provideHover: async (document, position, token) => {
          try {
            return await annotations?.provideHover(document, position, token);
          } catch (error) {
            if (
              !disposed &&
              !token.isCancellationRequested &&
              !cancelled(error)
            )
              await showOperationError(
                error instanceof Error ? error.message : String(error),
              );

            return null;
          }
        },
      },
    ),
    vscode.commands.registerCommand(
      commandId('open-blame-commit'),
      (value: unknown) => openCommit(value),
    ),
    vscode.window.onDidChangeActiveTextEditor(updateEnabled),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('git.enabled')) {
        commitRequest++;
        releaseAdapter();
        updateEnabled();
      }
    }),
    new vscode.Disposable(() => {
      disposed = true;
      lifetime.abort();
      annotations?.dispose();
      releaseAdapter();
      updateEnabled();
    }),
  );
  updateEnabled();
}
