import type { WorkingFile } from '@contracts/source-control';
import { PathHint } from '@webview/shared/ui';

import { type FileDecoration, fileDecoration } from '../model/file-status';
import styles from './SourceControlPage.module.css';

const categories: {
  kind: FileDecoration['kind'];
  symbol: string;
  label: string;
}[] = [
  { kind: 'added', symbol: 'A', label: 'added' },
  { kind: 'modified', symbol: 'M', label: 'modified' },
  { kind: 'deleted', symbol: 'D', label: 'deleted' },
  { kind: 'renamed', symbol: 'R', label: 'renamed' },
  { kind: 'untracked', symbol: 'U', label: 'untracked' },
  { kind: 'conflict', symbol: '!', label: 'conflicted' },
  { kind: 'unknown', symbol: '?', label: 'changed' },
];

export function CheckedFilesSummary({
  files,
  hoverDelay,
}: {
  files: readonly WorkingFile[];
  hoverDelay: number;
}) {
  if (!files.length) return null;
  const counts = new Map<FileDecoration['kind'], number>();

  for (const file of files) {
    const { kind } = fileDecoration(file.status, file.untracked);

    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return (
    <div
      role="status"
      aria-label="Checked files summary"
      aria-atomic="true"
      className={styles.checkedSummary}
    >
      {categories.map(({ kind, symbol, label }) => {
        const count = counts.get(kind) ?? 0;
        const description = `${count} ${label} ${count === 1 ? 'file' : 'files'} checked`;

        return count > 0 ? (
          <span key={kind} data-status={kind}>
            <PathHint text={description} delay={hoverDelay}>
              <span aria-hidden="true">
                {symbol} {count}
              </span>
              <span className={styles.srOnly}>{description}</span>
            </PathHint>
          </span>
        ) : null;
      })}
    </div>
  );
}
