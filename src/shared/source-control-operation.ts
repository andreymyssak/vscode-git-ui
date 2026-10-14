import type { SourceControlOperation } from './source-control';

export function operationPresentation(kind: SourceControlOperation['kind']) {
  switch (kind) {
    case 'merge':
      return {
        label: 'Abort Merge',
        tooltip:
          'Cancel the current Git merge and restore its pre-merge state. Conflict-resolution edits will be discarded.',
      };
    case 'rebase':
      return {
        label: 'Abort Rebase',
        tooltip:
          'Cancel the current Git rebase and return to its original branch and state. Conflict-resolution edits will be discarded.',
      };
    case 'cherry-pick':
      return {
        label: 'Abort Cherry-Pick',
        tooltip:
          'Cancel the current Git cherry-pick sequence and restore its original state. Conflict-resolution edits will be discarded.',
      };
    case 'revert':
      return {
        label: 'Abort Revert',
        tooltip:
          'Cancel the current Git revert sequence and restore its original state. Conflict-resolution edits will be discarded.',
      };
    case 'cherry-pick-files':
      return {
        label: 'Abort Selected Cherry-Pick',
        tooltip:
          'Undo this selected-file patch, including files that applied successfully. Restore the affected files and keep unrelated edits and staged files. Later edits to affected files will be discarded.',
      };
    case 'revert-files':
      return {
        label: 'Abort Selected Revert',
        tooltip:
          'Undo this selected-file revert, including files that applied successfully. Restore the affected files and keep unrelated edits and staged files. Later edits to affected files will be discarded.',
      };
    case 'conflicts':
      return {
        label: 'Discard Conflicts…',
        tooltip:
          'Restore only conflicted files to HEAD. Other changed or staged files are kept. A complete earlier patch cannot be identified, so this does not undo files that applied successfully.',
      };
  }
}
