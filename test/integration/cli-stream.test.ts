import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { GitCli } from '../../src/extension/git/cli';
import { executeStream } from '../../src/extension/git/cli-stream';
import { createFixture } from '../fixtures/repository';
import { squashAccess } from '../fixtures/squash-repository';

const options = { cwd: process.cwd(), env: process.env };
const waitingChild = `
  process.on('SIGTERM', () => setTimeout(() => process.exit(0), 30));
  process.stdout.write(String(process.pid));
  setInterval(() => {}, 1000);
`;

test('consumer stop waits until the child has closed', async () => {
  let pid = 0;

  await executeStream(
    process.execPath,
    ['-e', waitingChild],
    options,
    (chunk) => {
      pid = Number(chunk.toString());

      return false;
    },
  );
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
});

test('cancellation waits for termination and rejects with the caller reason', async () => {
  const controller = new AbortController();
  const reason = new Error('Superseded filtered read');
  let pid = 0;

  await expect(
    executeStream(
      process.execPath,
      ['-e', waitingChild],
      {
        ...options,
        signal: controller.signal,
      },
      (chunk) => {
        pid = Number(chunk.toString());
        controller.abort(reason);

        return true;
      },
    ),
  ).rejects.toBe(reason);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
});

test('unexpected process failures preserve bounded stderr and reject', async () => {
  await expect(
    executeStream(
      process.execPath,
      [
        '-e',
        `
    process.stderr.write('history read failed'); process.exit(17);
  `,
      ],
      options,
      () => true,
    ),
  ).rejects.toMatchObject({ code: 17, stderr: 'history read failed' });
});

test('consumer parsing errors terminate the process before rejection', async () => {
  const reason = new Error('Invalid record');
  let pid = 0;

  await expect(
    executeStream(process.execPath, ['-e', waitingChild], options, (chunk) => {
      pid = Number(chunk.toString());
      throw reason;
    }),
  ).rejects.toBe(reason);
  expect(() => process.kill(pid, 0)).toThrow();
});

test('a streamed write awaits its eligibility guard and rechecks cancellation before spawning', async () => {
  const fixture = await createFixture({ prefix: 'git-ui stream write guard ' });
  const cli = new GitCli(squashAccess(fixture.root));
  const controller = new AbortController();
  const reason = new Error('Write eligibility changed');

  try {
    await expect(
      cli.stream(
        'fixture',
        ['config', 'gitui.guard-test', 'written'],
        () => true,
        controller.signal,
        undefined,
        async () => {
          await Promise.resolve();
          controller.abort(reason);
        },
      ),
    ).rejects.toBe(reason);
    await expect(
      cli.run('fixture', ['config', '--get', 'gitui.guard-test']),
    ).rejects.toMatchObject({ code: 1 });
  } finally {
    await fixture.dispose();
  }
});

test.skipIf(process.platform === 'win32')(
  'cancellation escalates when its real process ignores SIGTERM',
  async () => {
    const controller = new AbortController();
    const reason = new Error('Stop ignored SIGTERM');
    let pid = 0;

    await expect(
      executeStream(
        process.execPath,
        [
          '-e',
          `
    process.on('SIGTERM', () => {});
    process.stdout.write(String(process.pid));
    setInterval(() => {}, 1000);
  `,
        ],
        { ...options, signal: controller.signal },
        (chunk) => {
          pid = Number(chunk.toString());
          controller.abort(reason);

          return true;
        },
      ),
    ).rejects.toBe(reason);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  },
);

test.skipIf(process.platform === 'win32')(
  'streamed CLI reads preserve inherited cancellation and await their deadline termination',
  async () => {
    const fixture = await createFixture({ prefix: 'git-ui stream deadline ' });

    try {
      const wrapper = join(fixture.root, 'git-wrapper.cjs');

      await writeFile(
        wrapper,
        `#!/usr/bin/env node
      const { execFileSync } = require('node:child_process');
      if (process.argv[2] === 'rev-parse') {
        process.stdout.write(execFileSync('git', process.argv.slice(2)));
      } else {
        ${waitingChild}
      }
    `,
      );
      await chmod(wrapper, 0o755);
      const access = squashAccess(fixture.root);
      const cli = new GitCli({
        ...access,
        api: { ...access.api, git: { path: wrapper } },
      });
      let deadlinePid = 0;

      await expect(
        cli.readOnly(undefined, 2000).stream('fixture', ['wait'], (chunk) => {
          deadlinePid = Number(chunk.toString());

          return true;
        }),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(deadlinePid).toBeGreaterThan(0);
      expect(() => process.kill(deadlinePid, 0)).toThrow();
      const controller = new AbortController();
      let cancelledPid = 0;

      await expect(
        cli.readOnly(controller.signal).stream('fixture', ['wait'], (chunk) => {
          cancelledPid = Number(chunk.toString());
          controller.abort();

          return true;
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(cancelledPid).toBeGreaterThan(0);
      expect(() => process.kill(cancelledPid, 0)).toThrow();
    } finally {
      await fixture.dispose();
    }
  },
);
