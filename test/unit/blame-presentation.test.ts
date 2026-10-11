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
  authorDate: new Date(2023, 10, 14, 12).toISOString(),
  summary: 'First',
};

describe('compact blame labels', () => {
  it.each([
    ['First Author', '14.11.2023 Author'],
    ['Andrey Myssak', '14.11.2023 Myssak'],
    ['  First   Author  ', '14.11.2023 Author'],
    ['单名', '14.11.2023 单名'],
  ])('keeps the date unambiguous and shortens %s', (authorName, label) => {
    expect(formatBlameLabel({ ...line, authorName })).toBe(label);
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
