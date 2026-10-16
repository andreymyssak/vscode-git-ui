import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, onTestFinished, test, vi } from 'vitest';

import { GitCli } from '../../src/extension/git/cli';
import { createHistoryMaintenance } from '../../src/extension/git/history-maintenance';
import { createFixture } from '../fixtures/repository';
import { squashAccess } from '../fixtures/squash-repository';

test
  .skipIf(process.platform === 'win32')
  .each(['invalidate', 'dispose'] as const)(
  '%s retains the common-directory maintenance lane until its real process closes',
  async (action) => {
    const fixture = await createFixture({
      prefix: 'git-ui maintenance lifecycle ',
    });
    const linkedRoot = join(fixture.root, 'linked');

    await fixture.runGit(['worktree', 'add', '--detach', linkedRoot, 'HEAD']);
    const starts = join(fixture.root, 'started');
    const termination = join(fixture.root, 'terminated');
    const release = join(fixture.root, 'release');
    const wrapper = join(fixture.root, 'slow-git.cjs');

    await writeFile(
      wrapper,
      `#!/usr/bin/env node
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      if (process.argv[2] === 'rev-parse') {
        process.stdout.write(execFileSync('git', process.argv.slice(2)));
      } else {
        process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(termination)}, 'received'));
        fs.appendFileSync(${JSON.stringify(starts)}, String(process.pid) + '\\n');
        setInterval(() => {
          if (fs.existsSync(${JSON.stringify(release)})) process.exit(0);
        }, 10);
      }
    `,
    );
    await chmod(wrapper, 0o755);
    let now = 0;
    const scheduled: (() => Promise<void>)[] = [];
    const maintenance = (root: string) => {
      const access = squashAccess(root);
      const reader = new GitCli(access);
      const writer = new GitCli({
        ...access,
        api: { ...access.api, git: { path: wrapper } },
      });

      return createHistoryMaintenance({
        access,
        cli: {
          run(id, args, signal, beforeExecute) {
            return (args[0] === 'commit-graph' ? writer : reader).run(
              id,
              args,
              signal,
              beforeExecute,
            );
          },
          stream: writer.stream.bind(writer),
        },
        isEnabled: () => true,
        isTrusted: () => true,
        now: () => now,
        schedule(task) {
          scheduled.push(task);

          return { dispose() {} };
        },
      });
    };

    const original = maintenance(fixture.root);
    const linked = maintenance(linkedRoot);
    const flush = async () => {
      await scheduled.shift()?.();
    };

    onTestFinished(async () => {
      original.dispose();
      linked.dispose();
      await writeFile(release, 'finish');
      await pending;
      // Clean up the fixture child even if the ownership assertion fails.
      const pids = (await readFile(starts, 'utf8').catch(() => ''))
        .trim()
        .split('\n');

      for (const value of pids) {
        const pid = Number(value);

        if (pid > 0) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already closed */
          }
        }
      }

      await fixture.dispose();
    });
    original.request('fixture');
    let settled = false;

    const pending = flush().then(() => {
      settled = true;
    });

    await vi.waitFor(
      async () =>
        expect((await readFile(starts, 'utf8')).trim()).toMatch(/^\d+$/),
      { timeout: 10000, interval: 10 },
    );
    const pid = Number((await readFile(starts, 'utf8')).trim());

    if (action === 'invalidate') original.invalidate('fixture');
    else original.dispose();
    await vi.waitFor(
      async () => expect(await readFile(termination, 'utf8')).toBe('received'),
      { timeout: 2000, interval: 10 },
    );
    expect(settled).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow();
    now = 300000;
    linked.request('fixture');
    await flush();
    expect((await readFile(starts, 'utf8')).trim().split('\n')).toHaveLength(1);
    await writeFile(release, 'finish');
    await pending;
    expect(() => process.kill(pid, 0)).toThrow();
    linked.request('fixture');
    await flush();
    expect((await readFile(starts, 'utf8')).trim().split('\n')).toHaveLength(2);
  },
);
