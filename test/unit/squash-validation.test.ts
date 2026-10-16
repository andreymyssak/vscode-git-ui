import { expect, test } from 'vitest';

import { validateSquashMessage } from '../../src/extension/git/squash';

test('squash message limit uses UTF-8 bytes including the exact boundary', () => {
  const boundary = 'é'.repeat(524288);

  expect(Buffer.byteLength(boundary, 'utf8')).toBe(1048576);
  expect(() => validateSquashMessage(boundary)).not.toThrow();
  expect(() => validateSquashMessage(boundary + 'é')).toThrow(
    /1 MiB|large|size/i,
  );
  expect(() => validateSquashMessage('a'.repeat(1048577))).toThrow(
    /1 MiB|large|size/i,
  );
});
test('squash messages accept literal multiline Unicode without trimming the draft', () => {
  expect(() =>
    validateSquashMessage("  Combined ü\n\nBody $() 'quoted'\n  "),
  ).not.toThrow();
});
test('blank or NUL squash messages reject before an operation can begin', () => {
  for (const message of ['', ' \n\t ', 'Message\0body']) {
    expect(() => validateSquashMessage(message)).toThrow(/blank|empty|NUL/i);
  }
});
