import type {
  BranchActionKind,
  CommitActionKind,
  WorktreeActionKind,
} from './messages';

/** The build injects only identity metadata from package.json. */
declare const __EXTENSION_IDENTITY__: {
  readonly name: string;
  readonly publisher: string;
  readonly displayName: string;
  readonly commandNamespace: string;
};

export const extensionIdentity = Object.freeze(__EXTENSION_IDENTITY__);

export const EXTENSION_ID = `${extensionIdentity.publisher}.${extensionIdentity.name}`;
export const LOG_VIEW_ID = `${extensionIdentity.commandNamespace}.log`;
export const CHANGES_VIEW_ID = `${extensionIdentity.commandNamespace}.changes`;
export const EMPTY_DOCUMENT_SCHEME = `${extensionIdentity.name}-empty`;
export const SNAPSHOT_DOCUMENT_SCHEME = `${extensionIdentity.name}-snapshot`;
export const SQUASH_RECOVERY_OWNER = `${extensionIdentity.name}-squash`;
export const SQUASH_HELPER_ID = `${SQUASH_RECOVERY_OWNER}-helper`;
export const RENDER_MEASUREMENT = `${extensionIdentity.name}.render`;

export type SourceControlActionKind =
  | 'refresh-changes'
  | 'check-all'
  | 'uncheck-all'
  | 'commit-checked'
  | 'rollback-selected'
  | 'commit-selected'
  | 'stash-selected'
  | 'copy-relative-path'
  | 'stash-checked'
  | 'show-changes'
  | 'discard-working-change'
  | 'resolve-conflicts'
  | 'accept-current'
  | 'accept-incoming'
  | 'stage-files'
  | 'unstage-files'
  | 'delete-files'
  | 'reveal-in-explorer'
  | 'reveal-in-os.mac'
  | 'reveal-in-os.windows'
  | 'reveal-in-os.linux'
  | 'open-stash-change'
  | 'apply-stash'
  | 'apply-stash-files'
  | 'delete-stash'
  | 'rename-stash'
  | 'delete-stash-files';

export function sourceControlCommandId(kind: SourceControlActionKind): string {
  return `${extensionIdentity.commandNamespace}.${kind}`;
}

export function commandId(
  kind:
    | BranchActionKind
    | CommitActionKind
    | WorktreeActionKind
    | 'annotate-blame'
    | 'close-blame'
    | 'open-blame-commit'
    | 'open-current-blame-commit'
    | 'blame-enabled',
): string {
  return `${extensionIdentity.commandNamespace}.${kind}`;
}
