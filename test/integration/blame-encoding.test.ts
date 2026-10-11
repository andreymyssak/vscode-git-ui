import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assert, expect, test } from 'vitest';

import { createBlameQueries } from '../../src/extension/git/blame';
import { utf8BlameCodec } from '../../src/extension/git/blame-bytes';
import type {
  BlameQuery,
  BlameTextCodec,
} from '../../src/extension/git/blame-model';
import { GitCli } from '../../src/extension/git/cli';
import { matchesBlameText } from '../../src/extension/native/blame-snapshot';
import { createFixture } from '../../test/fixtures/repository';
import { squashAccess } from '../../test/fixtures/squash-repository';

const latin1Codec: BlameTextCodec = {
  encode: async (text) => Buffer.from(text, 'latin1'),
  decode: async (bytes) => Buffer.from(bytes).toString('latin1'),
};

async function latin1Fixture() {
  const f = await createFixture({ prefix: 'git-ui-research-latin1-' });

  try {
    const path = 'latin1.txt';
    const committedBytes = Buffer.from('café\nASCII\n', 'latin1');

    await writeFile(join(f.root, path), committedBytes);
    await f.runGit(['add', '--', path]);
    await f.runGit(['commit', '-m', 'Add Latin-1 text']);
    const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();
    const access = squashAccess(f.root);
    const cli = new GitCli(access);
    const read = createBlameQueries(access, cli, latin1Codec);
    // The exact Unicode text VS Code presents after decoding this Latin-1 file.
    const displayedText = committedBytes.toString('latin1');

    return { ...f, path, sha, committedBytes, displayedText, read, cli };
  } catch (error) {
    await f.dispose();
    throw error;
  }
}

test('raw-byte Git control attributes the clean Latin-1 line to its commit', async (t) => {
  const f = await latin1Fixture();

  t.onTestFinished(() => f.dispose());
  expect(await f.runGit(['status', '--porcelain=v1'])).toBe('');
  expect(await readFile(join(f.root, f.path))).toEqual(f.committedBytes);

  const rawControl = await f.cli.runBytes('fixture', [
    'blame',
    '--encoding=UTF-8',
    '--line-porcelain',
    '--root',
    '--',
    f.path,
  ]);

  expect(rawControl.toString('latin1')).toContain(`\tcafé\n`);
  expect(rawControl.toString('latin1')).toMatch(new RegExp(`^${f.sha} 1 1`));
  expect(await f.runGit(['status', '--porcelain=v1'])).toBe('');
  expect(await readFile(join(f.root, f.path))).toEqual(f.committedBytes);
});

for (const specimen of [
  {
    name: 'Latin-1 CRLF',
    encoding: 'iso88591',
    text: 'café\r\nASCII\r\n',
    bytes: Buffer.from('café\r\nASCII\r\n', 'latin1'),
    codec: latin1Codec,
  },
  {
    name: 'UTF-8 CRLF',
    encoding: 'utf8',
    text: 'café\r\n東京\r\n',
    bytes: Buffer.from('café\r\n東京\r\n'),
    codec: utf8BlameCodec,
  },
  {
    name: 'UTF-8 BOM',
    encoding: 'utf8bom',
    text: 'café\n東京\n',
    bytes: Buffer.from('\uFEFFcafé\n東京\n'),
    codec: utf8BlameCodec,
  },
])
  test(`${specimen.name} keeps source bytes and Unicode commit metadata independent`, async (t) => {
    const f = await createFixture({ prefix: 'git-ui-blame-encoding-' });

    t.onTestFinished(() => f.dispose());
    const path = 'encoded.txt';
    const authorName = 'Олена 東京';
    const summary = 'Résumé 東京';

    await writeFile(join(f.root, path), specimen.bytes);
    await f.runGit(['add', '--', path]);
    await f.runGit([
      'commit',
      `--author=${authorName} <unicode@example.test>`,
      '-m',
      summary,
    ]);
    const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();
    const access = squashAccess(f.root);
    const read = createBlameQueries(access, new GitCli(access), specimen.codec);
    const sources: BlameQuery['source'][] = [
      { kind: 'revision', path, sha },
      { kind: 'contents', path, headSha: sha, contents: specimen.text },
    ];

    for (const source of sources) {
      const result = await read({
        repositoryId: 'fixture',
        source,
        encoding: specimen.encoding,
        ignoreWhitespace: false,
      });

      assert(result.kind === 'blame');
      expect(matchesBlameText(result.lines, specimen.text)).toBe(true);
      expect(result.lines).toHaveLength(2);
      for (const line of result.lines)
        expect(line).toMatchObject({
          kind: 'committed',
          sha,
          authorName,
          authorEmail: 'unicode@example.test',
          summary,
          originalPath: path,
        });
      expect(result.lines[0]?.text.replace(/\r$/, '')).toBe('café');
    }

    expect(await readFile(join(f.root, path))).toEqual(specimen.bytes);
    expect(await f.runGit(['status', '--porcelain=v1'])).toBe('');
  });

test('clean Latin-1 displayed contents retain committed attribution', async (t) => {
  const f = await latin1Fixture();

  t.onTestFinished(() => f.dispose());

  const result = await f.read({
    repositoryId: 'fixture',
    encoding: 'iso88591',
    ignoreWhitespace: false,
    source: {
      kind: 'contents',
      path: f.path,
      headSha: f.sha,
      contents: f.displayedText,
    },
  });

  assert(result.kind === 'blame');
  expect(result.lines[1]).toMatchObject({
    kind: 'committed',
    sha: f.sha,
    text: 'ASCII',
  });
  expect(matchesBlameText(result.lines, f.displayedText)).toBe(true);
  expect(await f.runGit(['status', '--porcelain=v1'])).toBe('');
  expect(await readFile(join(f.root, f.path))).toEqual(f.committedBytes);
  // Intended behavior: a clean decoded editor line retains its committed author.
  expect(result.lines[0]).toMatchObject({
    kind: 'committed',
    sha: f.sha,
    text: 'café',
  });
});

test('historical Latin-1 source text matches the decoded editor document', async (t) => {
  const f = await latin1Fixture();

  t.onTestFinished(() => f.dispose());
  const result = await f.read({
    repositoryId: 'fixture',
    encoding: 'iso88591',
    ignoreWhitespace: false,
    source: { kind: 'revision', path: f.path, sha: f.sha },
  });

  assert(result.kind === 'blame');
  expect(result.lines[1]).toMatchObject({
    kind: 'committed',
    sha: f.sha,
    text: 'ASCII',
  });
  expect(await f.runGit(['status', '--porcelain=v1'])).toBe('');
  expect(await readFile(join(f.root, f.path))).toEqual(f.committedBytes);
  // Intended behavior: attribution and text refer to the same displayed snapshot.
  expect
    .soft(result.lines[0])
    .toMatchObject({ kind: 'committed', sha: f.sha, text: 'café' });
  expect.soft(matchesBlameText(result.lines, f.displayedText)).toBe(true);
});

test('transformed working-tree-encoding is explicitly unsupported and uses revision attributes', async (t) => {
  const f = await latin1Fixture();

  t.onTestFinished(() => f.dispose());
  const rawSha = f.sha;

  await writeFile(
    join(f.root, '.gitattributes'),
    `${f.path} text working-tree-encoding=ISO-8859-1\n`,
  );
  await f.runGit(['add', '.gitattributes']);
  await f.runGit(['add', '--renormalize', '--', f.path]);
  await f.runGit(['commit', '-m', 'Store normalized UTF-8 blobs']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  expect(await f.cli.runBytes('fixture', ['show', `${sha}:${f.path}`])).toEqual(
    Buffer.from(f.displayedText),
  );
  const rawHistory = await f.read({
    repositoryId: 'fixture',
    encoding: 'iso88591',
    ignoreWhitespace: false,
    source: { kind: 'revision', path: f.path, sha: rawSha },
  });

  assert(rawHistory.kind === 'blame');
  expect(matchesBlameText(rawHistory.lines, f.displayedText)).toBe(true);
  for (const source of [
    { kind: 'revision', path: f.path, sha },
    { kind: 'contents', path: f.path, headSha: sha, contents: f.displayedText },
  ] satisfies BlameQuery['source'][])
    await expect(
      f.read({
        repositoryId: 'fixture',
        encoding: 'iso88591',
        ignoreWhitespace: false,
        source,
      }),
    ).rejects.toThrow(
      'Git blame does not support files transformed by working-tree-encoding.',
    );

  await writeFile(
    join(f.root, '.gitattributes'),
    `${f.path} -working-tree-encoding\n`,
  );
  await expect(
    f.read({
      repositoryId: 'fixture',
      encoding: 'iso88591',
      ignoreWhitespace: false,
      source: { kind: 'revision', path: f.path, sha },
    }),
  ).rejects.toThrow('working-tree-encoding');
  expect(await readFile(join(f.root, f.path))).toEqual(f.committedBytes);
});
