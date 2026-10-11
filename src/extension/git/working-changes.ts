import type { WorkingFile } from '../../shared/source-control';
import type { GitCli } from './cli';

export type { WorkingFile } from '../../shared/source-control';

export async function readWorkingChanges(
  cli: GitCli,
  id: string,
): Promise<WorkingFile[]> {
  const output = await cli.run(id, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  const entries = output.split('\0');
  const files: WorkingFile[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);

    if (entry[2] !== ' ' || !path)
      throw new Error('Invalid Git status response.');
    const renamed = /[RC]/.test(status);
    const originalPath = renamed ? entries[++i] : path;

    if (!originalPath) throw new Error('Missing original path in Git status.');
    files.push({
      path,
      originalPath,
      status,
      staged: status[0] !== ' ' && status[0] !== '?',
      working: status[1] !== ' ',
      untracked: status === '??',
    });
  }

  return files;
}
