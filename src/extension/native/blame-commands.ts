import * as vscode from 'vscode';
import { z } from 'zod';

import { commandId } from '../../shared/extension-identity';
import { createGitAdapter, type GitAdapter } from '../git/adapter';
import { getGitApi } from '../git/api';
import type { CommitJump } from '../panel/commit-jump';
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
  options: { revealCommit(target: CommitJump): Promise<void> },
): void {
  let annotations: BlameAnnotations | null = null;
  let adapter: Promise<GitAdapter> | null = null;
  let disposed = false;
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

    adapter = null;
    void previous?.then(
      (value) => value.dispose(),
      () => {},
    );
  };

  const readAdapter = async () => {
    adapter ??= createGitAdapter().catch((error: unknown) => {
      adapter = null;
      throw error;
    });
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
          (await readAdapter()).blame(query, signal),
      });
      context.subscriptions.push(annotations.onDidChangeEnabled(updateEnabled));
    }

    return annotations;
  };

  const run = async (work: () => void | Promise<void>): Promise<boolean> => {
    try {
      await getGitApi();
      if (disposed) return false;
      await work();

      return true;
    } catch (error) {
      if (!cancelled(error))
        await showOperationError(
          error instanceof Error ? error.message : String(error),
        );

      return false;
    } finally {
      updateEnabled();
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      commandId('annotate-blame'),
      (value: unknown) =>
        run(() => integration().annotate(commandEditor(value))),
    ),
    vscode.commands.registerCommand(
      commandId('close-blame'),
      (value: unknown) =>
        run(() => {
          const editor = commandEditor(value);

          annotations?.close(editor);
        }),
    ),
    vscode.commands.registerCommand(
      commandId('open-blame-commit'),
      (value: unknown) =>
        run(async () => {
          const parsed = commitArgument.safeParse(value);

          if (!parsed.success)
            throw new Error('This blame commit link is invalid.');
          const uri = vscode.Uri.parse(parsed.data.documentUri, true);
          const file = blameFileUri(uri);

          if (!file) throw new Error('This blame document is not a Git file.');
          const access = await getGitApi();
          const found = access.api.getRepository(file);

          if (!found)
            throw new Error('The source repository is no longer open.');
          const repositoryId = found.rootUri.toString();
          const repository = access.repository(repositoryId);

          await repository.getCommit(parsed.data.sha);
          access.repository(repositoryId);
          await options.revealCommit({ repositoryId, sha: parsed.data.sha });
        }),
    ),
    vscode.languages.registerHoverProvider(
      [{ scheme: 'file' }, { scheme: 'git' }],
      {
        async provideHover(document, position, token) {
          try {
            return (
              (await annotations?.provideHover(document, position, token)) ??
              null
            );
          } catch (error) {
            if (!token.isCancellationRequested && !cancelled(error))
              await showOperationError(
                error instanceof Error ? error.message : String(error),
              );

            return null;
          }
        },
      },
    ),
    vscode.window.onDidChangeActiveTextEditor(updateEnabled),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('git.enabled')) {
        releaseAdapter();
        updateEnabled();
      }
    }),
    new vscode.Disposable(() => {
      disposed = true;
      annotations?.dispose();
      releaseAdapter();
      updateEnabled();
    }),
  );
  updateEnabled();
}
