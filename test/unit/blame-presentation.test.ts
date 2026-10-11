import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
import type { BlameLine } from '../../src/extension/git/blame-model';
import { formatBlameLabel } from '../../src/extension/native/blame-presentation';

const line: BlameLine = {
  kind: 'committed',
  line: 1,
  text: 'first',
  originalLine: 1,
  originalPath: 'sample.txt',
  sha: 'a'.repeat(40),
  authorName: 'First Author',
  authorEmail: 'first@example.test',
  authorDate: '2023-11-14T22:13:20.000Z',
  summary: 'First',
};

describe('compact blame labels', () => {
  it('uses the local short date and the author', () => {
    const date = new Intl.DateTimeFormat(undefined, {
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date('2023-11-14T22:13:20.000Z'));

    expect(formatBlameLabel(line)).toBe(`${date} First Author`);
  });
  it('truncates long author names without splitting surrogate pairs', () => {
    expect(formatBlameLabel({ ...line, authorName: '😀'.repeat(20) })).toMatch(
      /😀{13}…$/u,
    );
  });
  it('marks uncommitted lines without attributing them to an author', () => {
    expect(
      formatBlameLabel({ kind: 'uncommitted', line: 1, text: 'new' }),
    ).toBe('Not committed yet');
  });
});
