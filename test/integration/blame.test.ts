import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assert, describe, expect, it } from 'vitest';

import { createBlameQueries } from '../../src/extension/git/blame';
import { GitCli } from '../../src/extension/git/cli';
import { createFixture } from '../fixtures/repository';
import {
  createSquashFixture,
  squashAccess,
} from '../fixtures/squash-repository';

async function fixture() {
  const repository = await createFixture({ prefix: 'git-ui-blame ü ' });
  const access = squashAccess(repository.root);
  const cli = new GitCli(access);
  const firstSha = (await repository.runGit(['rev-parse', 'HEAD'])).trim();
  const read = createBlameQueries(access, cli);

  return { ...repository, firstSha, read, cli };
}

describe('blame against real Git', () => {
  it('uses the requested root revision despite working changes', async (t) => {
    const f = await fixture();

    t.onTestFinished(() => f.dispose());
    await writeFile(join(f.root, 'sample.txt'), 'changed\n');
    const before = await f.runGit(['status', '--porcelain=v1']);
    const index = await f.runGit(['write-tree']);
    const result = await f.read({
      repositoryId: 'fixture',
      ignoreWhitespace: false,
      source: { kind: 'revision', path: 'sample.txt', sha: f.firstSha },
    });

    expect(result).toMatchObject({
      kind: 'blame',
      lines: [
        {
          kind: 'committed',
          sha: f.firstSha,
          originalLine: 1,
          authorName: 'Fixture',
          text: 'first',
        },
      ],
    });
    expect(await f.runGit(['status', '--porcelain=v1'])).toBe(before);
    expect(await f.runGit(['write-tree'])).toBe(index);
    expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(f.firstSha);
  });

  it('attributes unsaved inserted lines without shifting existing authorship', async (t) => {
    const f = await fixture();

    t.onTestFinished(() => f.dispose());
    const result = await f.read({
      repositoryId: 'fixture',
      ignoreWhitespace: false,
      source: {
        kind: 'contents',
        path: 'sample.txt',
        headSha: f.firstSha,
        contents: 'new\nfirst\n',
      },
    });

    expect(result).toMatchObject({
      kind: 'blame',
      lines: [
        { kind: 'uncommitted', line: 1, text: 'new' },
        { kind: 'committed', line: 2, sha: f.firstSha, text: 'first' },
      ],
    });
    expect(await f.runGit(['status', '--porcelain=v1'])).toBe('');
  });

  it('follows renamed files and can read the original side after deletion', async (t) => {
    const f = await fixture();

    t.onTestFinished(() => f.dispose());
    const name = process.platform === 'win32' ? 'new ü.txt' : 'new\t" ü.txt';

    await f.runGit(['mv', 'sample.txt', name]);
    await f.runGit(['commit', '-m', 'Rename']);
    const renameSha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

    expect(
      await f.runGit(['diff', '--name-status', '-M', f.firstSha, renameSha]),
    ).toContain('R100');
    await writeFile(join(f.root, name), 'first\nsecond\n');
    await f.runGit(['add', '--', name]);
    await f.runGit([
      'commit',
      '--author=Second Author <second@example.test>',
      '-m',
      'Rename and extend',
    ]);
    const renamed = (await f.runGit(['rev-parse', 'HEAD'])).trim();

    await f.runGit(['rm', '--', name]);
    await f.runGit(['commit', '-m', 'Delete']);
    const result = await f.read({
      repositoryId: 'fixture',
      ignoreWhitespace: false,
      source: { kind: 'revision', path: name, sha: renamed },
    });

    assert(result.kind === 'blame');
    expect(result.lines[0]).toMatchObject({
      sha: f.firstSha,
      originalPath: 'sample.txt',
    });
    expect(result.lines[1]).toMatchObject({
      sha: renamed,
      originalPath: name,
      authorName: 'Second Author',
    });
  });

  it('honors whitespace-ignore on displayed contents', async (t) => {
    const f = await fixture();

    t.onTestFinished(() => f.dispose());
    const source = {
      kind: 'contents' as const,
      path: 'sample.txt',
      headSha: f.firstSha,
      contents: '  first \n',
    };

    expect(
      await f.read({
        repositoryId: 'fixture',
        source,
        ignoreWhitespace: false,
      }),
    ).toMatchObject({ lines: [{ kind: 'uncommitted' }] });
    expect(
      await f.read({ repositoryId: 'fixture', source, ignoreWhitespace: true }),
    ).toMatchObject({
      lines: [{ kind: 'committed', sha: f.firstSha, text: '  first ' }],
    });
  });

  it('follows a staged rename for both index and working contents', async (t) => {
    const f = await fixture();

    t.onTestFinished(() => f.dispose());
    const name =
      process.platform === 'win32' ? 'staged ü.txt' : 'staged\t" ü.txt';

    await f.runGit(['mv', 'sample.txt', name]);
    await writeFile(join(f.root, name), 'first\nnew\n');
    const index = await f.runGit(['show', `:${name}`]);
    const before = await f.runGit(['status', '--porcelain=v1']);

    for (const contents of [index, 'first\nnew\n']) {
      const result = await f.read({
        repositoryId: 'fixture',
        ignoreWhitespace: false,
        source: { kind: 'contents', path: name, headSha: f.firstSha, contents },
      });

      assert(result.kind === 'blame');
      expect(result.lines[0]).toMatchObject({
        kind: 'committed',
        sha: f.firstSha,
        originalPath: 'sample.txt',
        text: 'first',
      });
      if (contents !== index)
        expect(result.lines[1]).toMatchObject({
          kind: 'uncommitted',
          text: 'new',
        });
    }

    expect(await f.runGit(['status', '--porcelain=v1'])).toBe(before);
    expect(await f.runGit(['show', `:${name}`])).toBe(index);
    expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(f.firstSha);
  });

  it('reports no history for a newly staged file', async (t) => {
    const f = await fixture();

    t.onTestFinished(() => f.dispose());
    await writeFile(join(f.root, 'new.txt'), 'new\n');
    await f.runGit(['add', '--', 'new.txt']);
    expect(
      await f.read({
        repositoryId: 'fixture',
        ignoreWhitespace: false,
        source: {
          kind: 'contents',
          path: 'new.txt',
          headSha: f.firstSha,
          contents: 'new\n',
        },
      }),
    ).toEqual({ kind: 'no-history' });
  });

  it('reports no history for an untracked file and an unborn repository', async (t) => {
    const f = await fixture();

    t.onTestFinished(() => f.dispose());
    const query = {
      repositoryId: 'fixture',
      ignoreWhitespace: false,
      source: {
        kind: 'contents' as const,
        path: 'new.txt',
        headSha: f.firstSha,
        contents: 'new\n',
      },
    };

    expect(await f.read(query)).toEqual({ kind: 'no-history' });
    await f.runGit(['update-ref', '-d', 'refs/heads/main']);
    expect(await f.read(query)).toEqual({ kind: 'no-history' });
  });

  it('keeps missing historical objects as errors', async (t) => {
    const f = await fixture();

    t.onTestFinished(() => f.dispose());
    await expect(
      f.read({
        repositoryId: 'fixture',
        ignoreWhitespace: false,
        source: { kind: 'revision', path: 'sample.txt', sha: 'a'.repeat(40) },
      }),
    ).rejects.toThrow();
  });

  it('retains complete SHA-256 hashes', async (t) => {
    const f = await createSquashFixture('sha256');

    t.onTestFinished(() => f.dispose());
    const access = squashAccess(f.root);
    const result = await createBlameQueries(
      access,
      new GitCli(access),
    )({
      repositoryId: 'fixture',
      ignoreWhitespace: false,
      source: { kind: 'revision', path: 'sample.txt', sha: f.initial },
    });

    expect(result).toMatchObject({
      kind: 'blame',
      lines: [{ kind: 'committed', sha: f.initial }],
    });
    expect(f.initial).toHaveLength(64);
  });
});
