import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { verifyBundleBudget } from '../../scripts/build/budget.ts';

const limits = [
  { file: 'extension.cjs', maxBytes: 819200 },
  { file: 'webview.js', maxBytes: 589824 },
  { file: 'webview.css', maxBytes: 73728 },
  { file: 'squash-helper.cjs', maxBytes: 10240 },
];
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'git-ui-bundle-budget-'));
  await Promise.all(
    limits.map(({ file }) => writeFile(join(directory, file), 'production')),
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('accepts production assets at their limits and ignores maps, fonts and licenses', async () => {
  await Promise.all([
    ...limits.map(({ file, maxBytes }) =>
      writeFile(join(directory, file), Buffer.alloc(maxBytes)),
    ),
    ...['webview.js.map', 'codicon.ttf', 'UI_LICENSES.txt'].map((file) =>
      writeFile(join(directory, file), Buffer.alloc(2 * 1024 * 1024)),
    ),
  ]);

  expect(await verifyBundleBudget(directory)).toEqual([
    { file: 'extension.cjs', bytes: 819200, maxBytes: 819200 },
    { file: 'webview.js', bytes: 589824, maxBytes: 589824 },
    { file: 'webview.css', bytes: 73728, maxBytes: 73728 },
    { file: 'squash-helper.cjs', bytes: 10240, maxBytes: 10240 },
  ]);
});

test.each(limits)(
  'rejects $file when the emitted file exceeds its budget by one byte',
  async ({ file, maxBytes }) => {
    await writeFile(join(directory, file), Buffer.alloc(maxBytes + 1));

    await expect(verifyBundleBudget(directory)).rejects.toThrow(
      `${file}: ${maxBytes + 1} bytes exceeds ${maxBytes} byte budget`,
    );
  },
);

test.each(limits)('requires the $file production output', async ({ file }) => {
  await rm(join(directory, file));

  await expect(verifyBundleBudget(directory)).rejects.toThrow(file);
});

test.each(limits)('rejects an empty $file output', async ({ file }) => {
  await writeFile(join(directory, file), '');

  await expect(verifyBundleBudget(directory)).rejects.toThrow(
    `${file}: production bundle is empty`,
  );
});

test('rejects a directory in place of an emitted production asset', async () => {
  await rm(join(directory, 'webview.js'));
  await mkdir(join(directory, 'webview.js'));

  await expect(verifyBundleBudget(directory)).rejects.toThrow(
    'webview.js: production bundle is empty or not a file',
  );
});
