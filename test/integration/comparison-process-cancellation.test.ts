import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import { createChangeQueries } from '../../src/extension/git/changes';
import { createSquashFixture } from '../fixtures/squash-repository';

test.each(['cat-file', 'diff-tree'])(
  'a shared root comparison keeps its %s child until the last caller cancels',
  async (command) => {
    const f = await createSquashFixture();
    const helper = join(f.directory, 'comparison-read.cjs');
    const marker = join(f.directory, 'comparison-started.json');
    const release = join(f.directory, 'comparison-release');
    const firstOwner = new AbortController();
    const lastOwner = new AbortController();
    const firstReason = new Error('The first viewer switched selection.');
    const lastReason = new Error('The last viewer closed.');

    await writeFile(
      helper,
      `const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = [require('node:path').basename(process.argv[1]), ...process.argv.slice(2)];
if (args[0] === ${JSON.stringify(command)} && !fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }));
  while (!fs.existsSync(${JSON.stringify(release)}))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  process.exit(0);
}
process.stdout.write(execFileSync('git', args, { env: { ...process.env, NODE_OPTIONS: '' } }));
process.exit(0);
`,
    );
    vi.stubEnv('NODE_OPTIONS', `--require ${JSON.stringify(helper)}`);
    Object.assign(f.access.api.git, { path: process.execPath });
    const changes = createChangeQueries(f.access, f.cli);
    const first = changes('fixture', f.initial, null, firstOwner.signal).catch(
      (error: unknown) => error,
    );
    let second: Promise<unknown> | undefined;

    try {
      let pid = 0;

      await vi.waitFor(async () => {
        pid = z
          .object({ pid: z.number().int().positive() })
          .parse(JSON.parse(await readFile(marker, 'utf8'))).pid;
      });
      second = changes('fixture', f.initial, null, lastOwner.signal).catch(
        (error: unknown) => error,
      );
      firstOwner.abort(firstReason);
      await expect(first).resolves.toBe(firstReason);
      expect(() => process.kill(pid, 0)).not.toThrow();
      lastOwner.abort(lastReason);
      await expect(second).resolves.toBe(lastReason);
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      await expect(changes('fixture', f.initial, null)).resolves.toMatchObject([
        { status: 'added', oldPath: null, newPath: 'sample.txt' },
      ]);
    } finally {
      changes.dispose();
      await writeFile(release, 'release');
      await Promise.allSettled([first, second]);
      vi.unstubAllEnvs();
      await f.dispose();
    }
  },
);
