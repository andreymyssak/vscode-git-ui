import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Raw emitted bytes, with headroom documented in docs/testing.md.
const productionBundleBudgets = [
  { file: 'extension.cjs', maxBytes: 800 * 1024 },
  { file: 'webview.js', maxBytes: 576 * 1024 },
  { file: 'webview.css', maxBytes: 72 * 1024 },
  { file: 'squash-helper.cjs', maxBytes: 10 * 1024 },
];

export async function verifyBundleBudget(directory: string) {
  return Promise.all(
    productionBundleBudgets.map(async ({ file, maxBytes }) => {
      const output = await stat(join(directory, file));

      if (!output.isFile() || output.size === 0)
        throw new Error(`${file}: production bundle is empty or not a file`);
      if (output.size > maxBytes)
        throw new Error(
          `${file}: ${output.size} bytes exceeds ${maxBytes} byte budget`,
        );

      return { file, bytes: output.size, maxBytes };
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const measurements = await verifyBundleBudget('dist');

  await mkdir('.artifacts', { recursive: true });
  await writeFile(
    '.artifacts/build-budget.json',
    JSON.stringify(measurements, null, 2) + '\n',
  );
  console.log(
    'Production bundle budget (raw bytes):\n' +
      measurements
        .map(({ file, bytes, maxBytes }) => `  ${file}: ${bytes} / ${maxBytes}`)
        .join('\n'),
  );
}
