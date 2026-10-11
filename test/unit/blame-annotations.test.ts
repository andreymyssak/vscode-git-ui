import { describe, expect, it } from 'vitest';

import type { BlameLine } from '../../src/extension/git/blame-model';
import { matchesBlameText } from '../../src/extension/native/blame-snapshot';

const line = (text: string, number: number): BlameLine => ({
  kind: 'uncommitted',
  text,
  line: number,
});

describe('annotation snapshot alignment', () => {
  it('matches CRLF lines and ignores only the synthetic final editor line', () => {
    expect(
      matchesBlameText(
        [line('first\r', 1), line('second\r', 2)],
        'first\r\nsecond\r\n',
      ),
    ).toBe(true);
  });
  it('does not discard a real empty line', () => {
    expect(matchesBlameText([line('first', 1), line('', 2)], 'first\n\n')).toBe(
      true,
    );
    expect(matchesBlameText([line('first', 1)], 'first\n\n')).toBe(false);
  });
  it('rejects attribution shifted by an unsaved insertion or edited text', () => {
    expect(matchesBlameText([line('first', 1)], 'new\nfirst\n')).toBe(false);
    expect(matchesBlameText([line('first', 1)], 'changed\n')).toBe(false);
  });
  it('matches empty and newline-less files', () => {
    expect(matchesBlameText([], '')).toBe(true);
    expect(matchesBlameText([line('first', 1)], 'first')).toBe(true);
    expect(matchesBlameText([], '\n')).toBe(false);
  });
});
