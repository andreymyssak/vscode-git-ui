import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { gitFixtureEnvironment } from './git-environment';

const execute = promisify(execFile);

declare global {
  var gitUiFixtureCleanup: ((root: string) => Promise<boolean>) | undefined;
}

export async function disposeFixtureDirectory(root: string): Promise<void> {
  if (await globalThis.gitUiFixtureCleanup?.(root)) return;
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

export interface Fixture {
  root: string;
  runGit(args: string[]): Promise<string>;
  dispose(): Promise<void>;
}
export async function createFixture(options: {
  prefix: string;
}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), options.prefix));

  try {
    const root = await realpath(directory);
    const globalConfig = join(root, 'isolated-gitconfig');

    await writeFile(globalConfig, '');
    const env = gitFixtureEnvironment({
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    });
    const runGit = async (args: string[]) =>
      (
        await execute('git', args, {
          cwd: root,
          env,
          maxBuffer: 32 * 1024 * 1024,
        })
      ).stdout;

    await runGit(['init', '--initial-branch=main']);
    await runGit(['config', 'core.autocrlf', 'false']);
    await runGit(['config', 'commit.gpgsign', 'false']);
    await runGit(['config', 'user.name', 'Fixture']);
    await runGit(['config', 'user.email', 'fixture@example.test']);
    await writeFile(join(root, '.gitignore'), 'isolated-gitconfig\n');
    await writeFile(join(root, 'sample.txt'), 'first\n');
    await runGit(['add', '.']);
    await runGit(['commit', '-m', 'Initial']);

    return {
      root,
      runGit,
      dispose: () => disposeFixtureDirectory(root),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    throw error;
  }
}

export async function commitWithDate(
  fixture: Fixture,
  tree: string,
  parent: string,
  message: string,
  date: string,
): Promise<string> {
  const env = gitFixtureEnvironment({
    GIT_CONFIG_GLOBAL: join(fixture.root, 'isolated-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });

  return (
    await execute('git', ['commit-tree', tree, '-p', parent, '-m', message], {
      cwd: fixture.root,
      env,
    })
  ).stdout.trim();
}

/** Create identical-tree history without a separate Git process for each revision. */
export async function commitLinearHistory(
  fixture: Fixture,
  parent: string,
  revisions: readonly { message: string; date: string }[],
): Promise<string> {
  if (!revisions.length) return parent;
  const ref = 'refs/fixture/linear-history';
  const stream = revisions.map(({ message, date }, index) => {
    const text = message + '\n';

    return (
      `commit ${ref}\nmark :${index + 1}\n` +
      `author Fixture <fixture@example.test> ${date}\n` +
      `committer Fixture <fixture@example.test> ${date}\n` +
      `data ${Buffer.byteLength(text)}\n${text}\n` +
      `from ${index === 0 ? parent : `:${index}`}\n\n`
    );
  });
  const env = gitFixtureEnvironment({
    GIT_CONFIG_GLOBAL: join(fixture.root, 'isolated-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  });

  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'git',
      ['fast-import', '--quiet', '--done'],
      { cwd: fixture.root, env },
      (error, stdout) => {
        if (error) reject(new Error(error.message, { cause: error }));
        else resolve(stdout.trim());
      },
    );

    child.stdin?.on('error', reject);
    child.stdin?.end(
      stream.join('') + `get-mark :${revisions.length}\nreset ${ref}\n\ndone\n`,
    );
  });
}
