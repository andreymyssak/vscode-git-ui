import type { WorkingFile } from '@contracts/source-control';

import { fileDecoration } from './file-status';

export type ChangeSection = 'merge' | 'index' | 'working';

export function changeGroups(files: readonly WorkingFile[]) {
  if (!files.length) return [];
  const merge: WorkingFile[] = [];
  const index: WorkingFile[] = [];
  const working: WorkingFile[] = [];

  for (const file of files) {
    if (fileDecoration(file.status, file.untracked).kind === 'conflict')
      merge.push(file);
    else {
      if (file.staged) index.push(file);
      if (file.working || file.untracked) working.push(file);
    }
  }

  return [
    ...(merge.length
      ? [{ section: 'merge' as const, label: 'Merge Changes', files: merge }]
      : []),
    ...(index.length
      ? [{ section: 'index' as const, label: 'Staged Changes', files: index }]
      : []),
    { section: 'working' as const, label: 'Changes', files: working },
  ];
}

export function sectionDecoration(file: WorkingFile, section: ChangeSection) {
  return fileDecoration(
    section === 'index' ? `${file.status[0]} ` : file.status,
    file.untracked,
  );
}

export function revealSection(files: readonly WorkingFile[], path: string) {
  return changeGroups(files)
    .filter((group) => group.files.some((file) => file.path === path))
    .at(-1)?.section;
}
