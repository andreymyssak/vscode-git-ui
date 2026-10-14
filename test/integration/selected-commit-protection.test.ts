import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, test } from 'vitest';

import { hasErrorCode } from '../../src/shared/validation';
import { selectedCommitFixture as setup } from '../fixtures/selected-commit-changes';

for (const kind of ['cherry-pick-files', 'revert-files'] as const)
  test.each([
    { path: 'new.txt', dirty: 'NEW.txt', existingParent: false },
    { path: '123/new.txt', dirty: '123/NEW.txt', existingParent: true },
    { path: 'nested/new.txt', dirty: 'NESTED/NEW.txt', existingParent: false },
    { path: 'caf\u00e9.txt', dirty: 'cafe\u0301.txt', existingParent: false },
  ])(
    `${kind} protects absent $path according to the filesystem's filename identity`,
    async ({ path, dirty, existingParent }) => {
      const f = await setup();
      let parent = f.c;

      if (kind === 'revert-files') {
        await mkdir(dirname(join(f.root, path)), { recursive: true });
        await writeFile(join(f.root, path), 'source\n');
        await f.runGit(['add', '.']);
        await f.runGit(['commit', '-m', 'Before deletion']);
        parent = (await f.runGit(['rev-parse', 'HEAD'])).trim();
      }

      await f.runGit(['switch', '-c', 'source']);
      if (kind === 'cherry-pick-files') {
        await mkdir(dirname(join(f.root, path)), { recursive: true });
        await writeFile(join(f.root, path), 'source\n');
        await f.runGit(['add', '.']);
      }

      const aliases = await realpath(join(f.root, dirty)).then(
        () => true,
        (error: unknown) => {
          if (!hasErrorCode(error, 'ENOENT')) throw error;

          return false;
        },
      );

      if (kind === 'revert-files') await f.runGit(['rm', path]);
      await f.runGit(['commit', '-m', 'Selected change']);
      const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

      if (kind === 'cherry-pick-files') await f.runGit(['switch', 'main']);
      if (existingParent)
        await mkdir(dirname(join(f.root, path)), { recursive: true });
      f.access.worktreeProtectionPaths = () => [join(f.root, dirty)];
      const before = await f.state();
      const result = await f.operate('fixture', {
        kind,
        sha,
        parentSha: parent,
        files: [
          kind === 'cherry-pick-files'
            ? { id: 'new', status: 'added', oldPath: null, newPath: path }
            : { id: 'new', status: 'deleted', oldPath: path, newPath: null },
        ],
        expectedBranch: kind === 'cherry-pick-files' ? 'main' : 'source',
        expectedHeadSha: kind === 'cherry-pick-files' ? f.c : sha,
      });

      if (aliases) {
        expect(result).toMatchObject({
          kind: 'error',
          recovery: 'source-control',
        });
        expect(await f.state()).toEqual(before);
        await expect(readFile(join(f.root, path))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } else {
        expect(result.kind).toBe('success');
        expect(await readFile(join(f.root, path), 'utf8')).toBe('source\n');
        await expect(readFile(join(f.root, dirty))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    },
  );

test('navigation cancellation during a read is silent and leaves the checkout unchanged', async () => {
  const f = await setup();
  const context = new AbortController();
  const run = f.cli.run.bind(f.cli);
  const exits: Promise<void>[] = [];
  const before = await f.state();

  f.cli.run = (id, args, signal) =>
    args[0] === 'cat-file'
      ? new Promise<string>((resolve, reject) => {
          const child = execFile(
            process.execPath,
            [
              '-e',
              'process.stdout.write("ready"); setInterval(() => {}, 1000)',
            ],
            { signal },
            (error, stdout) => {
              if (error) reject(error);
              else resolve(stdout);
            },
          );

          exits.push(
            new Promise<void>((done) => child.once('close', () => done())),
          );
          child.stdout?.once('data', () =>
            context.abort(new Error('The selected commit changed.')),
          );
        })
      : run(id, args, signal);

  try {
    const result = await f.operate(
      'fixture',
      {
        kind: 'cherry-pick-files',
        sha: f.c,
        parentSha: f.b,
        files: [
          {
            id: 'sample',
            status: 'modified',
            oldPath: 'sample.txt',
            newPath: 'sample.txt',
          },
        ],
        expectedBranch: 'main',
        expectedHeadSha: f.c,
      },
      context.signal,
    );

    expect(result.kind).toBe('cancelled');
    expect(await f.state()).toEqual(before);
  } finally {
    context.abort();
    await Promise.all(exits);
  }
});
