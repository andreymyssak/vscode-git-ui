import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { readWithCancellation } from '../read-cancellation';
import type { GitCli } from './cli';

export type GitCapabilityCli = Pick<GitCli, 'run'> & {
  readonly executablePath?: string | undefined;
};

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface GitCapabilities {
  readonly commitGraph: boolean;
  readonly commitGraphNoChangedPaths: boolean;
  readonly stableHistoryRewrite: boolean;
  readonly checkAttributeSource: boolean;
}

// Only completed, verified executable facts are shared. Repository state and
// pending probes belong to their callers, including their cancellation signals.
const versions = new Map<string, GitVersion>();
const maximumExecutables = 16;

export function parseGitVersion(text: string): GitVersion | null {
  const match =
    /^(?:git version )?(\d+)\.(\d+)\.(\d+)(?:\.windows\.\d+| \(Apple Git-\d+(?:\.\d+)*\))?$/.exec(
      text.trim(),
    );

  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  return [major, minor, patch].every(Number.isSafeInteger)
    ? { major, minor, patch }
    : null;
}

export function gitCapabilitiesForVersion(
  version: GitVersion | null,
): GitCapabilities {
  const since = (minor: number) =>
    version !== null &&
    (version.major > 2 || (version.major === 2 && version.minor >= minor));

  return {
    commitGraph: since(24),
    commitGraphNoChangedPaths: since(27),
    stableHistoryRewrite: since(47),
    checkAttributeSource: since(40),
  };
}

async function executableIdentity(
  path: string | undefined,
): Promise<string | null> {
  // Bare executable names depend on PATH. Without a resolved identity, probe
  // normally but do not retain a fact that could describe a different binary.
  if (!path || !isAbsolute(path)) return null;
  try {
    const canonical = await realpath(path);
    const file = await stat(canonical, { bigint: true });

    return file.isFile()
      ? `${canonical}\0${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`
      : null;
  } catch {
    return null;
  }
}

/** Lazy feature policy for the Git executable selected by VS Code. */
export async function readGitCapabilities(
  cli: GitCapabilityCli,
  repositoryId: string,
  signal?: AbortSignal,
): Promise<GitCapabilities> {
  signal?.throwIfAborted();
  const path = cli.executablePath;
  const identity = await executableIdentity(path);

  signal?.throwIfAborted();
  if (cli.executablePath !== path) return gitCapabilitiesForVersion(null);
  const cached = identity ? versions.get(identity) : undefined;

  if (cached) return gitCapabilitiesForVersion(cached);
  const version = parseGitVersion(
    await readWithCancellation(
      () => cli.run(repositoryId, ['--version'], signal),
      signal,
    ),
  );

  signal?.throwIfAborted();
  if (cli.executablePath !== path) return gitCapabilitiesForVersion(null);
  if (identity) {
    const current = await executableIdentity(path);

    signal?.throwIfAborted();
    if (current !== identity || cli.executablePath !== path)
      return gitCapabilitiesForVersion(null);
    if (version) {
      versions.set(identity, version);
      while (versions.size > maximumExecutables) {
        const oldest = versions.keys().next().value;

        if (oldest !== undefined) versions.delete(oldest);
      }
    }
  }

  return gitCapabilitiesForVersion(version);
}
