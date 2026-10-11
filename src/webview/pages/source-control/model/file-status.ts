import type { FileDecoration } from '@webview/shared/ui';

export type { FileDecoration } from '@webview/shared/ui';

const conflicts = new Map([
  ['DD', 'Both Deleted'],
  ['AU', 'Added By Us'],
  ['UD', 'Deleted By Them'],
  ['UA', 'Added By Them'],
  ['DU', 'Deleted By Us'],
  ['AA', 'Both Added'],
  ['UU', 'Both Modified'],
]);

export function fileDecoration(
  status: string,
  untracked = false,
): FileDecoration {
  if (untracked || status === '??')
    return {
      badge: 'U',
      description: 'Untracked',
      kind: 'untracked',
    };
  const conflict = conflicts.get(status);

  if (conflict)
    return {
      badge: '!',
      description: `Conflict: ${conflict}`,
      kind: 'conflict',
    };
  const porcelain = status.length === 2;
  const working = porcelain && status[1] !== ' ';
  const code = (working ? status[1] : status[0]) ?? '';
  const prefix = porcelain && !working ? 'Index ' : '';

  switch (code) {
    case 'R':
      return {
        badge: 'R',
        description: working ? 'Intent to Rename' : `${prefix}Renamed`,
        kind: 'renamed',
      };
    case 'D':
      return { badge: 'D', description: `${prefix}Deleted`, kind: 'deleted' };
    case 'A':
      return {
        badge: 'A',
        description: working ? 'Intent to Add' : `${prefix}Added`,
        kind: 'added',
      };
    case 'C':
      return { badge: 'C', description: `${prefix}Copied`, kind: 'modified' };
    case 'M':
      return { badge: 'M', description: `${prefix}Modified`, kind: 'modified' };
    case 'T':
      return { badge: 'T', description: 'Type Changed', kind: 'modified' };
    default:
      return { badge: '', description: 'Changed', kind: 'unknown' };
  }
}
