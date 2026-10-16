import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { installDiagnostics } from '../../src/extension/diagnostics';
import { GitCli } from '../../src/extension/git/cli';
import { executeStream } from '../../src/extension/git/cli-stream';
import { GitPartialCompletion } from '../../src/extension/git/partial-completion';
import {
  GitProcessFailure,
  gitProcessOutputLimit,
} from '../../src/extension/git/process-failure';
import { createFixture } from '../fixtures/repository';
import { squashAccess } from '../fixtures/squash-repository';

async function failure(
  read: () => Promise<unknown>,
): Promise<GitProcessFailure> {
  try {
    await read();
  } catch (error) {
    expect(error).toBeInstanceOf(GitProcessFailure);
    if (error instanceof GitProcessFailure) return error;
    throw error;
  }

  throw new Error('The process unexpectedly succeeded.');
}

test('buffered and streamed Git failures expose the same transport data and message', async () => {
  const fixture = await createFixture({ prefix: 'git-ui transport failure ' });

  try {
    const cli = new GitCli(squashAccess(fixture.root));
    const args = ['rev-parse', '--verify', 'refs/heads/missing'];
    const buffered = await failure(() => cli.run('fixture', args));
    const streamed = await failure(() =>
      cli.stream('fixture', args, () => true),
    );

    expect(buffered).toMatchObject({
      name: 'GitProcessFailure',
      reason: 'exit',
      code: 128,
      signal: null,
      stdout: '',
    });
    expect(streamed).toMatchObject({
      name: buffered.name,
      message: buffered.message,
      reason: 'exit',
      code: 128,
      signal: null,
      stdout: '',
      stderr: expect.any(String),
    });
    expect(buffered).toHaveProperty('cause');
    expect(streamed).toHaveProperty('cause');
    expect(buffered.stderr).toBe(streamed.stderr);
    expect(buffered.message).toContain('fatal:');
    expect(buffered.message).not.toContain('Command failed:');
    await expect(
      cli.run('fixture', ['config', '--get', 'gitui.missing-value']),
    ).rejects.toMatchObject({ code: 1, reason: 'exit', stderr: '' });
  } finally {
    await fixture.dispose();
  }
});

test('buffered and streamed spawn failures retain their Node cause and stable reason', async () => {
  const fixture = await createFixture({ prefix: 'git-ui missing executable ' });

  try {
    const access = squashAccess(fixture.root);
    const command = `${fixture.root}/missing-git`;
    const cli = new GitCli({
      ...access,
      api: { ...access.api, git: { path: command } },
    });
    const buffered = await failure(() => cli.run('fixture', ['status']));
    const streamed = await failure(() =>
      executeStream(
        command,
        ['status'],
        { cwd: fixture.root, env: process.env },
        () => true,
      ),
    );

    for (const error of [buffered, streamed]) {
      expect(error).toMatchObject({
        name: 'GitProcessFailure',
        reason: 'not-found',
        code: 'ENOENT',
        signal: null,
        stdout: '',
        stderr: '',
        cause: expect.objectContaining({ code: 'ENOENT' }),
      });
    }

    expect(buffered.message).toBe(streamed.message);
    expect(buffered.message).not.toContain(fixture.root);
  } finally {
    await fixture.dispose();
  }
});

test('synchronous process start failures use the same unknown fallback', async () => {
  const fixture = await createFixture({ prefix: 'git-ui invalid executable ' });

  try {
    const access = squashAccess(fixture.root);
    const cli = new GitCli({
      ...access,
      api: { ...access.api, git: { path: '' } },
    });
    const buffered = await failure(() => cli.run('fixture', ['status']));
    const streamed = await failure(() =>
      executeStream(
        '',
        ['status'],
        { cwd: fixture.root, env: process.env },
        () => true,
      ),
    );

    for (const error of [buffered, streamed]) {
      expect(error).toMatchObject({
        name: 'GitProcessFailure',
        reason: 'unknown',
        code: 'ERR_INVALID_ARG_VALUE',
        signal: null,
        stdout: '',
        stderr: '',
        cause: expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }),
      });
    }

    expect(buffered.message).toBe(streamed.message);
    expect(buffered.message).toContain('cannot be empty');
  } finally {
    await fixture.dispose();
  }
});

test.skipIf(process.platform === 'win32')(
  'real executable permission failures have the same transport reason',
  async () => {
    const fixture = await createFixture({
      prefix: 'git-ui denied executable ',
    });

    try {
      const command = join(fixture.root, 'unexecutable-git');

      await writeFile(command, 'Not executable');
      await chmod(command, 0o600);
      const access = squashAccess(fixture.root);
      const cli = new GitCli({
        ...access,
        api: { ...access.api, git: { path: command } },
      });
      const buffered = await failure(() => cli.run('fixture', ['status']));
      const streamed = await failure(() =>
        executeStream(
          command,
          ['status'],
          { cwd: fixture.root, env: process.env },
          () => true,
        ),
      );

      for (const error of [buffered, streamed]) {
        expect(error).toMatchObject({
          code: 'EACCES',
          signal: null,
          stdout: '',
          stderr: '',
          reason: 'permission-denied',
          cause: expect.objectContaining({ code: 'EACCES' }),
        });
      }

      expect(buffered.message).toBe(streamed.message);
    } finally {
      await fixture.dispose();
    }
  },
);

test('a consumer-thrown value remains intact after the streamed child closes', async () => {
  const reason = { problem: 'invalid record' };
  let pid = 0;

  await expect(
    executeStream(
      process.execPath,
      [
        '-e',
        'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);',
      ],
      { cwd: process.cwd(), env: process.env },
      (chunk) => {
        pid = Number(chunk.toString());
        throw reason;
      },
    ),
  ).rejects.toBe(reason);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
});

async function withProcessCli(
  source: string,
  check: (cli: GitCli, root: string) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture({ prefix: 'git-ui process wrapper ' });

  try {
    const wrapper = join(fixture.root, 'git-wrapper.cjs');

    await writeFile(
      wrapper,
      `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
if (process.argv[2] === 'rev-parse') {
  process.stdout.write(execFileSync('git', process.argv.slice(2)));
} else {
  ${source}
}
`,
    );
    await chmod(wrapper, 0o755);
    const access = squashAccess(fixture.root);

    await check(
      new GitCli({
        ...access,
        api: { ...access.api, git: { path: wrapper } },
      }),
      fixture.root,
    );
  } finally {
    await fixture.dispose();
  }
}

test.skipIf(process.platform === 'win32')(
  'buffered and streamed real subprocesses retain identical bounded output',
  async () => {
    await withProcessCli(
      `process.stdout.write('o'.repeat(${gitProcessOutputLimit + 100}), () => {
        process.stderr.write('e'.repeat(${gitProcessOutputLimit + 100}), () => process.exit(17));
      });`,
      async (cli) => {
        const buffered = await failure(() => cli.run('fixture', ['fail']));
        const streamed = await failure(() =>
          cli.stream('fixture', ['fail'], () => true),
        );

        for (const error of [buffered, streamed]) {
          expect(error).toMatchObject({
            reason: 'exit',
            code: 17,
            signal: null,
            stdout: 'o'.repeat(gitProcessOutputLimit),
            stderr: 'e'.repeat(gitProcessOutputLimit),
            message: 'e'.repeat(gitProcessOutputLimit),
          });
        }
      },
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'a process rejecting input reports its exit status in both runners',
  async () => {
    await withProcessCli(
      `process.stdin.destroy();
      process.stderr.write('Git rejected the input', () => process.exit(17));`,
      async (cli) => {
        const input = 'i'.repeat(1024 * 1024);
        const buffered = await failure(() =>
          cli.runWithInput('fixture', ['fail'], input),
        );
        const streamed = await failure(() =>
          cli.stream('fixture', ['fail'], () => true, undefined, input),
        );

        for (const error of [buffered, streamed]) {
          expect(error).toMatchObject({
            reason: 'exit',
            code: 17,
            signal: null,
            stderr: 'Git rejected the input',
            message: 'Git rejected the input',
          });
        }
      },
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'buffered reads preserve their caller cancellation reason and deadline identity',
  async () => {
    await withProcessCli(
      `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 30));
      require('node:fs').writeFileSync(process.argv[3], String(process.pid));
      setInterval(() => {}, 1000);`,
      async (cli, root) => {
        const controller = new AbortController();
        const reason = new Error('The caller superseded its buffered read.');
        const cancellationPid = join(root, 'cancellation.pid');
        const cancelled = cli
          .readOnly(controller.signal)
          .run('fixture', ['wait', cancellationPid])
          .catch((error: unknown) => error);
        const deadlinePid = join(root, 'deadline.pid');
        const deadlineOwner = new AbortController();
        const timedOut = cli
          .readOnly(deadlineOwner.signal, 2000)
          .run('fixture', ['wait', deadlinePid])
          .catch((error: unknown) => error);
        const readPid = async (path: string) => {
          try {
            return Number(await readFile(path, 'utf8'));
          } catch {
            return 0;
          }
        };

        const alive = (pid: number) => {
          try {
            process.kill(pid, 0);

            return true;
          } catch {
            return false;
          }
        };

        try {
          await expect.poll(() => readPid(cancellationPid)).toBeGreaterThan(0);
          controller.abort(reason);
          expect(await cancelled).toBe(reason);
          await expect.poll(() => readPid(deadlinePid)).toBeGreaterThan(0);
          expect(await timedOut).toMatchObject({ name: 'TimeoutError' });
          const cancelledPid = await readPid(cancellationPid);
          const timedOutPid = await readPid(deadlinePid);

          await expect.poll(() => alive(cancelledPid)).toBe(false);
          await expect.poll(() => alive(timedOutPid)).toBe(false);
        } finally {
          controller.abort();
          deadlineOwner.abort();
          await Promise.allSettled([cancelled, timedOut]);
        }
      },
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'signal termination has identical buffered and streamed transport data',
  async () => {
    await withProcessCli(
      `process.stdout.write('before termination', () => process.kill(process.pid, 'SIGTERM'));`,
      async (cli) => {
        const buffered = await failure(() => cli.run('fixture', ['signal']));
        const streamed = await failure(() =>
          cli.stream('fixture', ['signal'], () => true),
        );

        for (const error of [buffered, streamed]) {
          expect(error).toMatchObject({
            reason: 'signal',
            code: null,
            signal: 'SIGTERM',
            stdout: 'before termination',
            stderr: '',
            message: 'Git was terminated by SIGTERM.',
          });
        }
      },
    );
  },
);

test('process normalization leaves repository and eligibility failures intact', async () => {
  const fixture = await createFixture({ prefix: 'git-ui domain failure ' });

  try {
    const access = squashAccess(fixture.root);
    const reason = new GitPartialCompletion(
      'The first update completed.',
      'The next update failed.',
      new Error('Original write failure'),
    );
    const cli = new GitCli(access);
    const unavailable = new GitCli({
      ...access,
      repository() {
        throw reason;
      },
    });
    const guard = () => {
      throw reason;
    };

    await expect(unavailable.run('fixture', ['status'])).rejects.toBe(reason);
    await expect(
      unavailable.stream('fixture', ['status'], () => true),
    ).rejects.toBe(reason);
    await expect(cli.run('fixture', ['status'], undefined, guard)).rejects.toBe(
      reason,
    );
    await expect(
      cli.stream(
        'fixture',
        ['status'],
        () => true,
        undefined,
        undefined,
        guard,
      ),
    ).rejects.toBe(reason);
  } finally {
    await fixture.dispose();
  }
});

test('normalized process text remains outside diagnostic entries', async () => {
  const fixture = await createFixture({ prefix: 'git-ui diagnostic private ' });
  const entries: string[] = [];
  const logging = installDiagnostics((_level, entry) => entries.push(entry));

  try {
    const cli = new GitCli(squashAccess(fixture.root));
    const args = ['rev-parse', '--verify', 'refs/private/private-user-text'];

    await failure(() => cli.run('fixture', args));
    await failure(() => cli.stream('fixture', args, () => true));
    expect(entries).toHaveLength(4);
    expect(entries.join('')).not.toContain(fixture.root);
    expect(entries.join('')).not.toContain('private-user-text');
    expect(entries.join('')).not.toContain('fatal:');
  } finally {
    logging.dispose();
    await fixture.dispose();
  }
});
