import { expect, test } from 'vitest';

import { parseStashes, parseStashFiles } from '../../src/extension/git/stashes';

const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);
const index = 'c'.repeat(40);
const date = '2026-10-10T12:00:00+06:00';

test('stash listing parser accepts empty lists, full SHA-256 IDs, and a literal description', () => {
  expect(parseStashes('')).toEqual([]);
  expect(
    parseStashes(
      `${sha}\0stash@{4}\0On main: stash ü\0${date}\0${base} ${index}\0`,
    ),
  ).toEqual([
    { sha, selector: 'stash@{4}', message: 'On main: stash ü', date, base },
  ]);
  const long = 'd'.repeat(64);

  expect(
    parseStashes(`${long}\0stash@{0}\0\0${date}\0${long} ${long}\0`)[0]?.sha,
  ).toBe(long);
});

test('stash listing parser accepts Git UTC timestamps with a Z suffix', () => {
  const utc = '2026-10-10T12:00:00Z';

  expect(
    parseStashes(
      `${sha}\0stash@{0}\0Saved changes\0${utc}\0${base} ${index}\0`,
    ),
  ).toEqual([
    { sha, selector: 'stash@{0}', message: 'Saved changes', date: utc, base },
  ]);
});

for (const output of [
  'incomplete',
  `${sha}\0stash@{0}\0message\0${date}\0${base}\0`,
  `${sha.slice(0, 7)}\0stash@{0}\0message\0${date}\0${base} ${index}\0`,
  `${sha}\0HEAD\0message\0${date}\0${base} ${index}\0`,
  `${sha}\0stash@{0}\0message\0invalid-date\0${base} ${index}\0`,
]) {
  test('stash listing parser refuses malformed Git metadata', () => {
    expect(() => parseStashes(output)).toThrow();
  });
}

test('stash file parser retains rename paths and filenames containing newlines or tabs', () => {
  const files = parseStashFiles(
    'R100\0old\nname\0new\tname\0A\0:(glob)*\0D\0deleted\0',
    'working',
    base,
    sha,
  );

  expect(files).toEqual([
    {
      path: 'new\tname',
      originalPath: 'old\nname',
      status: 'R100',
      snapshot: 'working',
      oldRef: base,
      newRef: sha,
      deleted: false,
    },
    {
      path: ':(glob)*',
      originalPath: ':(glob)*',
      status: 'A',
      snapshot: 'working',
      oldRef: null,
      newRef: sha,
      deleted: false,
    },
    {
      path: 'deleted',
      originalPath: 'deleted',
      status: 'D',
      snapshot: 'working',
      oldRef: base,
      newRef: sha,
      deleted: true,
    },
  ]);
});

for (const output of [
  'A\0path',
  'R100\0old\0',
  'X\0path\0',
  'M\0../outside\0',
  'A\0/absolute\0',
  'A\0\0',
]) {
  test('stash file parser refuses incomplete or unsafe paths and unknown statuses', () => {
    expect(() => parseStashFiles(output, 'working', base, sha)).toThrow();
  });
}

test('saved paths reject Windows drive, rooted and backslash traversal paths on Windows', () => {
  for (const path of [
    'C:/outside',
    'C:outside',
    '\\outside',
    '\\\\server\\share',
    'folder\\..\\outside',
  ]) {
    expect(() =>
      parseStashFiles(`A\0${path}\0`, 'untracked', null, sha, 'win32'),
    ).toThrow(/path/i);
  }

  expect(
    parseStashFiles('A\0folder/file.txt\0', 'untracked', null, sha, 'win32')[0]
      ?.path,
  ).toBe('folder/file.txt');
});

test('saved POSIX filenames preserve literal backslashes and drive-like directory names', () => {
  expect(
    parseStashFiles(
      'A\0C:/saved.txt\0A\0literal\\name\0',
      'untracked',
      null,
      sha,
      'linux',
    ).map((file) => file.path),
  ).toEqual(['C:/saved.txt', 'literal\\name']);
});
