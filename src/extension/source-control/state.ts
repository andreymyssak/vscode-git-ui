import * as vscode from 'vscode';

import type { Loaded, SourceControlState } from '../../shared/source-control';
import { formatPathLabel } from '../native/path-label';
import type { SourceControlModel } from './model';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loaded<T>(work: Promise<T[]>): Promise<Loaded<T>> {
  try {
    return { kind: 'ready', items: await work };
  } catch (error) {
    return { kind: 'error', message: errorMessage(error) };
  }
}

export function publicationState(
  state: ReturnType<SourceControlModel['state']>,
): SourceControlState {
  return {
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
  };
}
