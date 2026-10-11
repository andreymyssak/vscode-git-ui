import { describe, expect, it } from 'vitest';

import { parseBlamePorcelain } from '../../src/extension/git/blame-porcelain';
import { blameSha, porcelainRecord } from '../fixtures/blame';

describe('blame porcelain', () => {
  it('keeps displayed line order and the original path and line', () => {
    const lines = parseBlamePorcelain(
      porcelainRecord() +
        porcelainRecord({ originalLine: 8, line: 2, text: 'second' }),
    );

    expect(lines.map(({ line, text }) => ({ line, text }))).toEqual([
      { line: 1, text: 'first' },
      { line: 2, text: 'second' },
    ]);
    expect(lines[0]).toEqual({
      kind: 'committed',
      line: 1,
      text: 'first',
      originalLine: 7,
      originalPath: 'old ü.txt',
      sha: blameSha,
      authorName: 'First Author',
      authorEmail: 'first@example.test',
      authorDate: '2023-11-14T22:13:20.000Z',
      summary: 'First change',
    });
  });

  it.each([40, 64])(
    'recognizes a %i-character zero hash as uncommitted',
    (length) => {
      expect(
        parseBlamePorcelain(porcelainRecord({ sha: '0'.repeat(length) })),
      ).toEqual([{ kind: 'uncommitted', line: 1, text: 'first' }]);
    },
  );

  it('retains full SHA-256 identities and root commits', () => {
    expect(
      parseBlamePorcelain(
        porcelainRecord({ sha: 'b'.repeat(64), extra: 'boundary\n' }),
      )[0],
    ).toMatchObject({ kind: 'committed', sha: 'b'.repeat(64) });
  });

  it('decodes C-quoted filename bytes without treating them as shell text', () => {
    const output = porcelainRecord({
      filename: '"old\\t\\"\\\\ \\303\\274.txt"',
    });

    expect(parseBlamePorcelain(output)[0]).toMatchObject({
      originalPath: 'old\t"\\ ü.txt',
    });
  });

  it('ignores optional metadata and preserves carriage returns in file text', () => {
    expect(
      parseBlamePorcelain(
        porcelainRecord({ extra: 'future-field value\n', text: 'line\r' }),
      )[0],
    ).toMatchObject({ text: 'line\r' });
  });

  it('accepts an empty file', () => {
    expect(parseBlamePorcelain('')).toEqual([]);
  });

  it.each([
    'a 1 1\n\ttext\n',
    `${blameSha} 0 1\n\ttext\n`,
    `${blameSha} 1 1\nauthor Someone\n`,
    porcelainRecord().replace('author-time 1700000000', 'author-time invalid'),
    porcelainRecord().replace('filename old ü.txt\n', ''),
    porcelainRecord({ filename: '"bad\\q"' }),
    porcelainRecord({ filename: '"bad\\"' }),
    porcelainRecord({ line: 2 }),
  ])('rejects incomplete or malformed attribution: %s', (output) => {
    expect(() => parseBlamePorcelain(output)).toThrow();
  });
});
