// Public API-1 structural declarations adapted from Microsoft vscode.git git.d.ts.
// Source: 07f806f999227108933c2e30515b26eecc1fda74/extensions/git/src/api/git.d.ts
// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import * as vscode from 'vscode';

import { extensionIdentity } from '../../shared/extension-identity';
import type { RepositoryInfo } from '../../shared/model';
import type { GitApiInitialization } from './api-initialization';
import { waitForGitInitialization } from './api-initialization';

export interface GitRef {
  readonly type: 0 | 1 | 2;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
  readonly upstream?: { remote: string; name: string; commit?: string };
}
export interface GitCommit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
  readonly authorDate?: Date;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly commitDate?: Date;
}
export interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri: vscode.Uri | undefined;
  readonly status: number;
}
export interface GitLogOptions {
  maxEntries?: number;
  skip?: number;
  grep?: string;
  refNames?: string[];
}
export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: GitRef | undefined;
    readonly refs: GitRef[];
    readonly worktrees: {
      name: string;
      path: string;
      ref: string;
      main: boolean;
      detached: boolean;
    }[];
    readonly remotes: { name: string; fetchUrl?: string; pushUrl?: string }[];
    readonly mergeChanges: GitChange[];
    readonly onDidChange: vscode.Event<void>;
  };
  status(): Promise<void>;
  clean(paths: string[]): Promise<void>;
  getBranch(name: string): Promise<GitRef>;
  getRefs(query: { pattern?: string }): Promise<GitRef[]>;
  log(options?: GitLogOptions): Promise<GitCommit[]>;
  getCommit(ref: string): Promise<GitCommit>;
  getConfig(key: string): Promise<string>;
  diffBetween(ref1: string, ref2: string): Promise<GitChange[]>;
  show(ref: string, path: string): Promise<string>;
  checkout(treeish: string): Promise<void>;
  merge(ref: string): Promise<void>;
  rebase(branch: string): Promise<void>;
  createWorktree(options?: {
    path?: string;
    commitish?: string;
    branch?: string;
    noTrack?: boolean;
  }): Promise<string>;
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
  tag(name: string, message: string, ref?: string): Promise<void>;
  deleteBranch(name: string, force?: boolean): Promise<void>;
  fetch(options?: {
    all?: boolean;
    remote?: string;
    ref?: string;
  }): Promise<void>;
  setBranchUpstream(name: string, upstream: string): Promise<void>;
}
export interface GitAPI extends GitApiInitialization {
  readonly repositories: GitRepository[];
  readonly git: { path: string };
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  openRepository(root: vscode.Uri): Promise<GitRepository | null>;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  getRepository(uri: vscode.Uri): GitRepository | null;
}
export interface GitApiAccess {
  api: GitAPI;
  repository(id: string): GitRepository;
  repositories(): RepositoryInfo[];
  worktreeProtectionPaths?(): readonly string[];
}

interface GitExtension {
  enabled: boolean;
  getAPI(version: 1): GitAPI;
}

export async function getGitApi(): Promise<GitApiAccess> {
  if (!vscode.workspace.isTrusted)
    throw new Error('Trust this workspace through VS Code to use Git.');
  if (!vscode.workspace.getConfiguration('git').get<boolean>('enabled', true))
    throw new Error('Enable Git in VS Code settings.');
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');

  if (!extension) throw new Error('Enable VS Code’s built-in Git extension.');
  await extension.activate();
  if (!extension.exports.enabled)
    throw new Error('Enable Git in VS Code settings and install Git.');
  const api = extension.exports.getAPI(1);

  await waitForGitInitialization(api);

  return {
    api,
    repository(id) {
      const repository = api.repositories.find(
        (repo) => repo.rootUri.toString() === id,
      );

      if (
        repository &&
        (!vscode.workspace.isTrusted ||
          !vscode.workspace
            .getConfiguration('git', repository.rootUri)
            .get<boolean>('enabled', true))
      )
        throw new Error('Enable Git and trust this workspace through VS Code.');
      if (!repository)
        throw new Error(
          `Repository is no longer available. Refresh ${extensionIdentity.displayName}.`,
        );

      return repository;
    },
    worktreeProtectionPaths: () => [
      ...(vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === 'file')
        .map((folder) => folder.uri.fsPath),
      ...vscode.workspace.textDocuments
        .filter(
          (document) => document.isDirty && document.uri.scheme === 'file',
        )
        .map((document) => document.uri.fsPath),
    ],
    repositories: () =>
      api.repositories
        .filter((repo) => existsSync(repo.rootUri.fsPath))
        .map((repo) => ({
          id: repo.rootUri.toString(),
          label: basename(repo.rootUri.fsPath),
          rootUri: repo.rootUri.toString(),
          headSha: repo.state.HEAD?.commit ?? null,
          branch: repo.state.HEAD?.name ?? null,
        })),
  };
}
