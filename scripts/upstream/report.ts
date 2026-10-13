import type { BinaryLike } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadManifest, safePath } from './reproduce.ts';
import type {
  ManifestInput,
  ReportFailure,
  ReportOptions,
  Sha256,
  UpstreamChange,
  UpstreamReport,
  UpstreamTransport,
  WatchedInput,
} from './types.ts';
import {
  parseRepository,
  parseReview,
  parseRevision,
  parseSha256,
  parseTreePaths,
} from './validation.ts';
import { verify } from './verify.ts';

export const hash = (data: BinaryLike): Sha256 =>
  parseSha256(createHash('sha256').update(data).digest('hex'));

export const githubTransport: UpstreamTransport = {
  async file(repository, ref, path) {
    parseRevision(ref);
    parseRepository(repository);
    const response = await fetch(
      `https://raw.githubusercontent.com/${repository}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`,
      { signal: AbortSignal.timeout(20000) },
    );

    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`Source HTTP ${response.status}: ${path}`);

    return Buffer.from(await response.arrayBuffer());
  },
  async tree(repository, ref) {
    parseRevision(ref);
    parseRepository(repository);
    const response = await fetch(
      `https://api.github.com/repos/${repository}/git/trees/${ref}?recursive=1`,
      { signal: AbortSignal.timeout(20000) },
    );

    if (!response.ok) throw new Error(`Tree HTTP ${response.status}`);
    const value: unknown = await response.json();

    return parseTreePaths(value);
  },
  async notes(url) {
    const parsed = new URL(url);

    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'code.visualstudio.com'
    )
      throw new Error('Use the official VS Code release-notes URL.');
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });

    if (!response.ok) throw new Error(`Release notes HTTP ${response.status}`);

    return Buffer.from(await response.arrayBuffer());
  },
};

type ReportInput =
  | (ManifestInput & { kind: 'copied'; category: string })
  | (WatchedInput & { kind: 'watched' });

export async function reportChanges(
  manifestPath: string,
  target: string,
  transport: UpstreamTransport = githubTransport,
  options: ReportOptions = {},
): Promise<UpstreamReport> {
  const targetRevision = parseRevision(target);

  await verify(manifestPath);
  const { manifest, root } = await loadManifest(manifestPath);
  const failures: ReportFailure[] = [];
  const inputs: ReportInput[] = [
    ...manifest.inputs.map((input): ReportInput => ({
      ...input,
      kind: 'copied',
      category:
        input.role === 'declarations'
          ? 'api'
          : input.role === 'test'
            ? 'tests'
            : 'graph',
    })),
    ...(manifest.watched ?? []).map((input): ReportInput => ({
      ...input,
      kind: 'watched',
    })),
  ];
  const changes = await Promise.all(
    inputs.map(async (input): Promise<UpstreamChange> => {
      const repository = input.repository ?? manifest.repository;
      const item = {
        path: input.path,
        repository,
        kind: input.kind,
        category: input.category,
        baselineRevision: input.revision,
        oldHash: input.sha256,
        possibleMoves: [],
        disposition: null,
        comparisonUrl: `https://github.com/${repository}/compare/${input.revision}...${targetRevision}`,
      };

      try {
        if (
          input.localPath &&
          hash(await readFile(safePath(root, input.localPath))) !== input.sha256
        )
          throw new Error(`Input hash mismatch: ${input.path}`);
        const data = await transport.file(
          repository,
          targetRevision,
          input.path,
        );

        if (data === null) {
          const tree = await transport.tree(repository, targetRevision);

          return {
            ...item,
            state: 'missing',
            newHash: null,
            possibleMoves: tree.filter(
              (path) =>
                basename(path) === basename(input.path) && path !== input.path,
            ),
          };
        }

        const newHash = hash(data);

        return {
          ...item,
          newHash,
          state: newHash === input.sha256 ? 'unchanged' : 'changed',
        };
      } catch (error) {
        failures.push({ path: input.path, message: String(error) });

        return { ...item, newHash: null, state: 'failed' };
      }
    }),
  );

  if (manifest.releaseNotes) {
    const notes = manifest.releaseNotes;
    const url =
      options.releaseNotesUrl ??
      (targetRevision === notes.revision ? notes.url : null);
    const item = {
      path: url ?? 'Release notes for target revision',
      kind: 'watched',
      category: 'release-notes',
      baselineRevision: notes.revision,
      oldHash: notes.sha256,
      possibleMoves: [],
      disposition: null,
    } satisfies Omit<UpstreamChange, 'state' | 'newHash'>;

    try {
      if (!url)
        throw new Error(
          'Supply --notes-url for the stable release matching the target revision.',
        );
      if (!transport.notes)
        throw new Error('Release-notes transport is unavailable.');
      const newHash = hash(await transport.notes(url));

      changes.push({
        ...item,
        newHash,
        state: newHash === notes.sha256 ? 'unchanged' : 'changed',
      });
    } catch (error) {
      failures.push({ path: item.path, message: String(error) });
      changes.push({ ...item, state: 'failed', newHash: null });
    }
  }

  return {
    repository: manifest.repository,
    targetRevision,
    adoptedRevisions: [
      ...new Set(manifest.inputs.map((input) => input.revision)),
    ],
    lastReviewedRevision: manifest.lastReviewedRevision,
    status: failures.length
      ? 'failed'
      : changes.some(
            (item) => item.state === 'changed' || item.state === 'missing',
          )
        ? 'changes'
        : 'no-changes',
    changes,
    failures,
    reviewRequired: changes
      .filter((item) => item.state === 'changed' || item.state === 'missing')
      .map((item) => item.path),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);

  if (args[0] === '--review') {
    const reviewPath = args[1];

    if (!reviewPath) throw new Error('Supply the source report to review.');
    const value: unknown = JSON.parse(
      await readFile(resolve(reviewPath), 'utf8'),
    );

    parseReview(value);
    console.log(
      'Review dispositions validated. Adoption remains an explicit developer step.',
    );
    process.exit(0);
  }

  const target = parseRevision(args[0]);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);

    return index < 0 ? undefined : args[index + 1];
  };

  const releaseNotesUrl = option('--notes-url');
  const report = await reportChanges(
    resolve('upstream/vscode/manifest.json'),
    target,
    githubTransport,
    releaseNotesUrl === undefined ? {} : { releaseNotesUrl },
  );
  const output = resolve(
    option('--out') ?? `.artifacts/upstream-report-${target.slice(0, 12)}.json`,
  );

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `${report.status}: ${report.reviewRequired.length} candidates, ${report.failures.length} failures. ${output}`,
  );
  if (report.status === 'failed') process.exitCode = 1;
}
