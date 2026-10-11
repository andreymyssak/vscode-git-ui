import { expect, test } from 'vitest';

import { formatPathLabel } from '../../src/extension/native/path-label';

test.each([
  ['/home/john', '/home/john', '~'],
  ['/home/john/projects/my repo/src', '/home/john', '~/projects/my repo/src'],
  ['/home/johnny/projects', '/home/john', '/home/johnny/projects'],
  ['/workspace/project', '/home/john', '/workspace/project'],
])(
  'labels %s relative to the home directory only when contained',
  (path, home, expected) => {
    expect(formatPathLabel({ path, home, windows: false })).toBe(expected);
  },
);

test.each([
  ['C:\\Users\\John', 'C:\\Users\\John', 'C:\\Users\\John'],
  [
    'C:\\Users\\John\\projects\\my repo',
    'C:\\Users\\John',
    'C:\\Users\\John\\projects\\my repo',
  ],
  ['c:\\Users\\John\\repo', 'C:\\Users\\John', 'C:\\Users\\John\\repo'],
  [
    'C:\\Users\\JohnSmith\\repo',
    'C:\\Users\\John',
    'C:\\Users\\JohnSmith\\repo',
  ],
  ['D:\\project', 'C:\\Users\\John', 'D:\\project'],
  [
    '\\\\server\\workspace\\project',
    'C:\\Users\\John',
    '\\\\server\\workspace\\project',
  ],
])(
  'keeps Windows separators and drive boundaries for %s',
  (path, home, expected) => {
    expect(formatPathLabel({ path, home, windows: true })).toBe(expected);
  },
);
