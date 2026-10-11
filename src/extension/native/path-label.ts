import { homedir } from 'node:os';
import { posix } from 'node:path';

/** Match VS Code's file labels, including home-relative labels on macOS and Linux. */
export function formatPathLabel({
  path,
  home = homedir(),
  windows = process.platform === 'win32',
}: {
  path: string;
  home?: string;
  windows?: boolean;
}): string {
  if (windows) return path.replace(/^[a-z]:/i, (drive) => drive.toUpperCase());
  const paths = posix;
  const relative = paths.relative(home, path);

  if (!relative) return '~';
  if (
    relative !== '..' &&
    !relative.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(relative)
  )
    return `~${paths.sep}${relative}`;

  return path;
}
