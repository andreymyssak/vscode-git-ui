import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { assert, expect, onTestFinished, test } from 'vitest';

import { gitFixtureEnvironment } from '../fixtures/git-environment';
import { createFixture } from '../fixtures/repository';

const execute = promisify(execFile);
// Multi-command workflows must outlive each child command's 45-second limit.
const workflowTimeout = process.platform === 'win32' ? 120000 : 30000;

async function fixture(message = 'feat: add branch filtering') {
  const f = await createFixture({ prefix: 'git-ui-native release ' });

  onTestFinished(f.dispose);
  const remote = join(f.root, '.artifacts', 'remote.git');
  const npm = process.env.npm_execpath;

  assert.ok(npm, 'Run release tests through an npm test command.');
  const env = gitFixtureEnvironment({
    GIT_CONFIG_GLOBAL: join(f.root, 'isolated-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  const scripts = Object.fromEntries(
    Object.entries(manifest.scripts).filter(([name]) =>
      name.startsWith('release'),
    ),
  );

  scripts['release:validate'] = 'node checks.cjs';
  await symlink(
    resolve('node_modules'),
    join(f.root, 'node_modules'),
    'junction',
  );
  for (const file of ['.release-it.json', '.release-it.publish.cjs'])
    await copyFile(resolve(file), join(f.root, file));
  await writeFile(
    join(f.root, '.gitignore'),
    'isolated-gitconfig\nnode_modules/\n.artifacts/\n',
  );
  // A public fixture exercises npm.publish=false without access to a registry.
  await writeFile(join(f.root, '.npmrc'), 'registry=http://127.0.0.1:9/\n');
  await writeFile(
    join(f.root, 'package.json'),
    JSON.stringify({
      name: 'release-fixture',
      version: '1.0.0',
      private: false,
      scripts,
    }),
  );
  await writeFile(
    join(f.root, 'package-lock.json'),
    JSON.stringify({
      name: 'release-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'release-fixture', version: '1.0.0' } },
    }),
  );
  await writeFile(
    join(f.root, 'CHANGELOG.md'),
    '# Changelog\n\n## 1.0.0\n\nInitial release.\n',
  );
  await writeFile(
    join(f.root, 'checks.cjs'),
    `require('node:fs').writeFileSync('.artifacts/checks-ran.txt', 'Checks ran.');
if (process.env.RELEASE_FIXTURE_FAIL) throw new Error('Fixture checks failed');
`,
  );
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'chore: set up release fixture']);
  await f.runGit(['tag', 'v1.0.0']);
  await mkdir(join(f.root, '.artifacts'), { recursive: true });
  await f.runGit(['init', '--bare', remote]);
  await f.runGit(['remote', 'add', 'origin', remote]);
  await f.runGit(['push', '--set-upstream', 'origin', 'main']);
  await f.runGit(['push', 'origin', 'v1.0.0']);
  await writeFile(join(f.root, 'sample.txt'), 'new behavior\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', message]);

  return {
    ...f,
    remote,
    read: (file: string) => readFile(join(f.root, file), 'utf8'),
    run: (
      name: string,
      args: string[] = [],
      overrides: NodeJS.ProcessEnv = {},
    ) =>
      execute(process.execPath, [npm, 'run', name, '--', '--ci', ...args], {
        cwd: f.root,
        env: { ...env, ...overrides },
        timeout: 45000,
        maxBuffer: 1024 * 1024,
      }),
    remoteGit: (args: string[]) => f.runGit(['--git-dir', remote, ...args]),
    commitPrepared: async () => {
      await f.runGit([
        'add',
        'package.json',
        'package-lock.json',
        'CHANGELOG.md',
      ]);
      await f.runGit(['commit', '-m', 'chore: prepare release']);
    },
  };
}

test.each([
  ['fix: correct branch counts', '1.0.1'],
  ['feat: add branch filtering', '1.1.0'],
  ['feat!: change the branch API', '2.0.0'],
])(
  'preparation derives a release for %s without committing, tagging or pushing',
  async (message, version) => {
    const f = await fixture(message);
    const head = await f.runGit(['rev-parse', 'HEAD']);
    const remoteHead = await f.remoteGit(['rev-parse', 'main']);

    await f.run('release:prepare');
    expect(JSON.parse(await f.read('package.json')).version).toBe(version);
    const lock = JSON.parse(await f.read('package-lock.json'));

    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);
    expect(await f.read('CHANGELOG.md')).toContain(version);
    expect(await f.runGit(['rev-parse', 'HEAD'])).toBe(head);
    expect((await f.runGit(['tag', '--list'])).trim()).toBe('v1.0.0');
    expect(await f.remoteGit(['rev-parse', 'main'])).toBe(remoteHead);
    expect((await f.remoteGit(['tag', '--list'])).trim()).toBe('v1.0.0');
  },
  60000,
);

test('preview leaves the version, notes, working tree and tags unchanged', async () => {
  const f = await fixture();
  const manifest = await f.read('package.json');
  const notes = await f.read('CHANGELOG.md');

  await f.run('release:preview');
  expect(await f.read('package.json')).toBe(manifest);
  expect(await f.read('CHANGELOG.md')).toBe(notes);
  expect((await f.runGit(['status', '--porcelain'])).trim()).toBe('');
  expect((await f.runGit(['tag', '--list'])).trim()).toBe('v1.0.0');
});

test('the first release can keep its chosen version while preparing notes', async () => {
  const f = await fixture();

  await f.runGit(['tag', '--delete', 'v1.0.0']);
  await f.runGit(['push', 'origin', '--delete', 'v1.0.0']);
  await f.run('release:prepare', ['--no-increment']);
  expect(JSON.parse(await f.read('package.json')).version).toBe('1.0.0');
  expect(await f.read('CHANGELOG.md')).toContain('branch filtering');
  expect((await f.runGit(['tag', '--list'])).trim()).toBe('');
});

test(
  'release tags and pushes the prepared version without running checks',
  async () => {
    const f = await fixture();

    await f.run('release:prepare');
    await f.commitPrepared();
    const notes = await f.read('CHANGELOG.md');
    const manifest = await f.read('package.json');
    const revision = (await f.runGit(['rev-parse', 'HEAD'])).trim();

    await f.run('release', ['--no-github'], { RELEASE_FIXTURE_FAIL: '1' });
    await expect(f.read('.artifacts/checks-ran.txt')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await f.runGit(['rev-parse', 'v1.1.0^{}'])).trim()).toBe(revision);
    expect((await f.remoteGit(['rev-parse', 'v1.1.0^{}'])).trim()).toBe(
      revision,
    );
    expect(await f.read('CHANGELOG.md')).toBe(notes);
    expect(await f.read('package.json')).toBe(manifest);
    expect((await f.runGit(['status', '--porcelain'])).trim()).toBe('');
  },
  workflowTimeout,
);

test(
  'checks can run independently without tagging or pushing',
  async () => {
    const f = await fixture();

    await f.run('release:prepare');
    await f.commitPrepared();
    const remoteHead = await f.remoteGit(['rev-parse', 'main']);

    await expect(
      f.run('release:validate', [], { RELEASE_FIXTURE_FAIL: '1' }),
    ).rejects.toMatchObject({ code: 1 });
    expect(await f.read('.artifacts/checks-ran.txt')).toBe('Checks ran.');
    expect((await f.runGit(['tag', '--list'])).trim()).toBe('v1.0.0');
    expect((await f.remoteGit(['tag', '--list'])).trim()).toBe('v1.0.0');
    expect(await f.remoteGit(['rev-parse', 'main'])).toBe(remoteHead);
  },
  workflowTimeout,
);

test.each(['dirty', 'other branch'])(
  'release rejects a candidate on %s before remote writes',
  async (state) => {
    const f = await fixture();

    await f.run('release:prepare');
    await f.commitPrepared();
    if (state === 'dirty')
      await writeFile(join(f.root, 'sample.txt'), 'uncommitted\n');
    else await f.runGit(['checkout', '-b', 'feature/not-main']);
    const remoteHead = await f.remoteGit(['rev-parse', 'main']);

    await expect(f.run('release', ['--no-github'])).rejects.toMatchObject({
      code: 1,
    });
    expect((await f.runGit(['tag', '--list'])).trim()).toBe('v1.0.0');
    expect(await f.remoteGit(['rev-parse', 'main'])).toBe(remoteHead);
  },
  workflowTimeout,
);

test('GitHub notes copy generated release entries and reject absent versions', async () => {
  const f = await fixture();

  for (const message of [
    'ci: report validation results',
    'test: cover branch filtering',
  ])
    await f.runGit(['commit', '--allow-empty', '-m', message]);
  await f.run('release:prepare');
  const readNotes = () =>
    execute(
      process.execPath,
      [
        '-e',
        "console.log(require('./.release-it.publish.cjs').github.releaseNotes({ version: '1.1.0' }))",
      ],
      { cwd: f.root },
    );

  const notes = (await readNotes()).stdout.trim();
  const changelog = await f.read('CHANGELOG.md');
  const generatedEntries = changelog
    .slice(changelog.indexOf('### Features'), changelog.indexOf('## 1.0.0'))
    .trim();

  expect(notes).toMatch(/^### Features\b/);
  expect(notes).toContain('add branch filtering');
  expect(notes).not.toContain('report validation results');
  expect(notes).not.toContain('cover branch filtering');
  expect(notes).not.toContain('Initial release.');
  expect(notes).toBe(generatedEntries);
  await writeFile(
    join(f.root, 'CHANGELOG.md'),
    '# Changelog\n\n## 1.0.0\n\nOlder change.\n',
  );
  await expect(readNotes()).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Missing release notes'),
  });
});

test('maintenance releases preserve an empty generated release section', async () => {
  const f = await fixture('chore: update Marketplace metadata');

  await f.run('release:prepare', ['1.0.1']);
  const { stdout } = await execute(
    process.execPath,
    [
      '-e',
      "console.log(JSON.stringify(require('./.release-it.publish.cjs').github.releaseNotes({ version: '1.0.1' })))",
    ],
    { cwd: f.root },
  );

  expect(JSON.parse(stdout)).toBe('');
  expect(await f.read('CHANGELOG.md')).not.toContain(
    'update Marketplace metadata',
  );
});
