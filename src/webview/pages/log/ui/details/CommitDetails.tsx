import { useState } from 'react';

import { Icon } from '@webview/shared/ui';

import {
  buildReferenceLabels,
  descriptions,
} from '../../model/reference-labels';
import type { LogData, LogIntent } from '../../model/view';
import { ChangedFiles } from './ChangedFiles';
import styles from './CommitDetails.module.css';

type DetailsSnapshot = Pick<
  LogData,
  | 'details'
  | 'files'
  | 'fileErrors'
  | 'selectedSha'
  | 'selectedParentSha'
  | 'selectedFilePath'
> & { repositoryId: string | null };

export function CommitDetails({
  data,
  onIntent,
}: {
  data: LogData;
  onIntent(this: void, intent: LogIntent): void;
}) {
  const repositoryId = data.repository?.id ?? null;
  const comparison =
    data.selectedParentSha ?? data.details?.parents[0] ?? 'root';
  const complete = !!data.details && Object.hasOwn(data.files, comparison);
  const failed = !!data.fileErrors[comparison];
  const [settled, setSettled] = useState<DetailsSnapshot | null>(null);

  if (
    settled &&
    (settled.repositoryId !== repositoryId ||
      (failed &&
        data.details?.sha === data.selectedSha &&
        settled.details?.sha !== data.details?.sha))
  )
    setSettled(null);
  else if (
    complete &&
    (!data.selectedSha || data.details?.sha === data.selectedSha) &&
    (settled?.details !== data.details ||
      settled.files !== data.files ||
      settled.fileErrors !== data.fileErrors ||
      settled.selectedParentSha !== data.selectedParentSha ||
      settled.selectedFilePath !== data.selectedFilePath)
  )
    setSettled({
      repositoryId,
      details: data.details,
      files: data.files,
      fileErrors: data.fileErrors,
      selectedSha: data.selectedSha,
      selectedParentSha: data.selectedParentSha,
      selectedFilePath: data.selectedFilePath,
    });
  const pending =
    (!!data.selectedSha &&
      ((!complete && !failed) || data.details?.sha !== data.selectedSha)) ||
    (data.loading && !data.details);
  const retained =
    !!settled &&
    settled.repositoryId === repositoryId &&
    pending &&
    !data.error;
  const displayed = retained ? { ...data, ...settled } : data;
  const commit = displayed.details;
  const labels = commit
    ? buildReferenceLabels(
        displayed.refs.filter((ref) => ref.sha === commit.sha),
        displayed.repository,
        commit.sha,
      ).labels
    : [];

  return (
    <aside
      id="details"
      aria-label="Commit details"
      className={styles.details}
      aria-busy={pending && !data.error}
      inert={retained}
    >
      {commit ? (
        <>
          <section className={styles['changes-section']}>
            <ChangedFiles
              key={commit.sha}
              data={displayed}
              onIntent={onIntent}
              inactive={retained}
            />
          </section>
          <section className={styles['commit-info']} data-commit-info="">
            <div className={styles['commit-description']}>
              <pre className={styles['commit-message']}>{commit.message}</pre>
              <div className={styles['commit-metadata']}>
                <p>
                  <span className={styles['commit-sha']} title={commit.sha}>
                    {commit.sha.slice(0, 8)}
                  </span>{' '}
                  <span>{commit.authorName ?? 'Unknown author'}</span>
                </p>
                {commit.authorEmail && (
                  <p>
                    <a
                      className={styles.email}
                      href={'mailto:' + encodeURIComponent(commit.authorEmail)}
                    >
                      {'<' + commit.authorEmail + '>'}
                    </a>
                  </p>
                )}
                <p>
                  Committed{' '}
                  {commit.commitDate ? (
                    <time dateTime={commit.commitDate}>
                      {new Date(commit.commitDate).toLocaleString()}
                    </time>
                  ) : (
                    'at an unknown date'
                  )}
                </p>
                {labels.length > 0 && (
                  <div
                    className={styles.references}
                    role="group"
                    aria-label="Branches and tags at this commit"
                  >
                    {(['head', 'local', 'remote', 'tag'] as const).map(
                      (kind) => {
                        const names = labels
                          .filter((label) => label.kind === kind)
                          .map((label) => label.name);

                        return names.length > 0 ? (
                          <p
                            key={kind}
                            aria-label={
                              descriptions[kind] + ': ' + names.join(', ')
                            }
                          >
                            <span
                              className={styles.referenceIcon}
                              data-reference-kind={kind}
                              title={descriptions[kind]}
                            >
                              <Icon name="tag" />
                            </span>
                            <span>{names.join(', ')}</span>
                          </p>
                        ) : null;
                      },
                    )}
                  </div>
                )}
                {commit.parents.length > 1 && (
                  <p>
                    Parents:{' '}
                    {commit.parents.map((sha) => sha.slice(0, 8)).join(', ')}
                  </p>
                )}
              </div>
            </div>
          </section>
        </>
      ) : data.error ? null : (
        <p className={styles.empty}>
          {data.selectedSha
            ? 'Loading commit…'
            : 'Select a commit to see its details and changed files.'}
        </p>
      )}
    </aside>
  );
}
