import type {
  SourceControlBridge,
  SourceControlRepository,
} from '@contracts/source-control';
import { ActionButton, FileTreeCheckbox } from '@webview/shared/ui';

import styles from './SourceControlPage.module.css';

export function CommitMessageToolbar({
  repository,
  disabled,
  generating,
  canGenerate,
  bridge,
}: {
  repository: SourceControlRepository | null;
  disabled: boolean;
  generating: boolean;
  canGenerate: boolean;
  bridge: SourceControlBridge;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Commit message actions"
      className={styles.messageToolbar}
    >
      <label className={styles.amend}>
        <FileTreeCheckbox
          label="Amend last commit"
          checked={repository?.commitMode.kind === 'amend'}
          disabled={
            disabled ||
            (!repository?.info.headSha &&
              repository?.commitMode.kind !== 'amend')
          }
          onChange={(enabled) => {
            if (repository && !disabled)
              bridge.send({
                kind: 'amend',
                repositoryId: repository.info.id,
                enabled,
              });
          }}
        />
        <span>Amend last commit</span>
      </label>
      <ActionButton
        label="Commit Message History"
        icon="history"
        className={styles.iconButton}
        disabled={disabled || !repository?.hasMessageHistory}
        onClick={() => {
          if (repository && !disabled)
            bridge.send({
              kind: 'message-history',
              repositoryId: repository.info.id,
            });
        }}
      />
      {generating ? (
        <ActionButton
          label="Cancel Generation"
          icon="close"
          className={styles.iconButton}
          onClick={() => bridge.send({ kind: 'cancel-generation' })}
        />
      ) : (
        <ActionButton
          label="Generate Commit Message"
          icon="sparkle"
          tooltip="Generate a message for checked files"
          className={styles.iconButton}
          disabled={!canGenerate}
          onClick={() => {
            if (repository && canGenerate)
              bridge.send({
                kind: 'generate',
                repositoryId: repository.info.id,
              });
          }}
        />
      )}
    </div>
  );
}
