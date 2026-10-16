import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, onTestFinished, test } from 'vitest';

import {
  gitCapabilitiesForVersion,
  type GitCapabilityCli,
  parseGitVersion,
  readGitCapabilities,
} from '../../src/extension/git/capabilities';

test.each([
  ['2.47.0', { major: 2, minor: 47, patch: 0 }],
  ['git version 2.47.1\n', { major: 2, minor: 47, patch: 1 }],
  ['git version 2.47.1.windows.2', { major: 2, minor: 47, patch: 1 }],
  ['git version 2.50.1 (Apple Git-155)', { major: 2, minor: 50, patch: 1 }],
  ['2.47.0 (Apple Git-150.1)', { major: 2, minor: 47, patch: 0 }],
])('parses known stable Git distribution %s', (version, expected) => {
  expect(parseGitVersion(version)).toEqual(expected);
});

test.each([
  '2.47.0-rc1',
  'git version 2.47.0.rc1',
  'git version 2.47.0.GIT',
  '2.47.0 (custom vendor)',
  '2.47.0 (Apple Git-155-rc1)',
  '2.47.0.windows.1-extra',
  'prefix 2.47.1',
  '2.47',
  '999999999999999999999.47.1',
  '',
])('does not infer capabilities from unverified version %s', (version) => {
  expect(parseGitVersion(version)).toBeNull();
  expect(gitCapabilitiesForVersion(parseGitVersion(version))).toEqual({
    commitGraph: false,
    commitGraphNoChangedPaths: false,
    stableHistoryRewrite: false,
    checkAttributeSource: false,
  });
});

test.each([
  ['1.99.0', false, false, false, false],
  ['2.23.9', false, false, false, false],
  ['2.24.0', true, false, false, false],
  ['2.26.9', true, false, false, false],
  ['2.27.0', true, true, false, false],
  ['2.39.9', true, true, false, false],
  ['2.40.0', true, true, false, true],
  ['2.46.9', true, true, false, true],
  ['2.47.0', true, true, true, true],
  ['2.47.1.windows.1', true, true, true, true],
  ['2.47.0 (Apple Git-155)', true, true, true, true],
  ['3.0.0', true, true, true, true],
])(
  'applies independent feature floors on %s',
  (
    version,
    commitGraph,
    commitGraphNoChangedPaths,
    stableHistoryRewrite,
    checkAttributeSource,
  ) => {
    expect(gitCapabilitiesForVersion(parseGitVersion(version))).toEqual({
      commitGraph,
      commitGraphNoChangedPaths,
      stableHistoryRewrite,
      checkAttributeSource,
    });
  },
);

async function executableFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'git-ui-capabilities-'));
  const path = join(directory, 'git');

  await writeFile(path, 'installed executable');
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directory, path };
}

test('reuses installed executable version across repositories and CLI reader instances', async () => {
  const f = await executableFixture();
  let probes = 0;
  const run: GitCapabilityCli['run'] = async (_id, args) => {
    expect(args).toEqual(['--version']);
    probes++;

    return 'git version 2.47.1';
  };

  expect(
    (await readGitCapabilities({ executablePath: f.path, run }, 'one'))
      .stableHistoryRewrite,
  ).toBe(true);
  expect(
    (await readGitCapabilities({ executablePath: f.path, run }, 'two'))
      .commitGraph,
  ).toBe(true);
  expect(probes).toBe(1);
});

test('rechecks a replacement executable at the same path', async () => {
  const f = await executableFixture();
  let version = 'git version 2.47.1';
  let probes = 0;
  const cli = {
    executablePath: f.path,
    run: async () => {
      probes++;

      return version;
    },
  };

  expect((await readGitCapabilities(cli, 'one')).stableHistoryRewrite).toBe(
    true,
  );
  const replacement = join(f.directory, 'replacement');

  await writeFile(replacement, 'replacement executable');
  await rename(replacement, f.path);
  version = 'git version 2.46.9';
  expect((await readGitCapabilities(cli, 'two')).stableHistoryRewrite).toBe(
    false,
  );
  expect(probes).toBe(2);
});

test('bounds retained executable facts when selected Git paths keep changing', async () => {
  const f = await executableFixture();
  let probes = 0;
  const cli = {
    executablePath: f.path,
    run: async () => {
      probes++;

      return 'git version 2.47.1';
    },
  };

  await readGitCapabilities(cli, 'one');
  for (let index = 0; index < 16; index++) {
    const path = join(f.directory, `git-${index}`);

    await writeFile(path, `executable ${index}`);
    cli.executablePath = path;
    await readGitCapabilities(cli, 'one');
  }

  cli.executablePath = f.path;
  expect((await readGitCapabilities(cli, 'one')).stableHistoryRewrite).toBe(
    true,
  );
  expect(probes).toBe(18);
});

test('uses the selected executable and resolves changed symlink targets', async () => {
  const f = await executableFixture();
  const other = join(f.directory, 'other');
  const selected = join(f.directory, 'selected');
  let version = 'git version 2.47.1';
  let probes = 0;
  const cli = {
    executablePath: selected,
    run: async () => {
      probes++;

      return version;
    },
  };

  await writeFile(other, 'different executable');
  await symlink(f.path, selected);
  expect((await readGitCapabilities(cli, 'one')).stableHistoryRewrite).toBe(
    true,
  );
  await rm(selected);
  await symlink(other, selected);
  version = 'git version 2.39.9';
  expect((await readGitCapabilities(cli, 'one')).checkAttributeSource).toBe(
    false,
  );
  cli.executablePath = f.path;
  version = 'git version 2.47.1';
  expect((await readGitCapabilities(cli, 'one')).stableHistoryRewrite).toBe(
    true,
  );
  expect(probes).toBe(2);
});

test.each(['missing', 'unknown'] as const)(
  'a %s version probe does not cache a permanent failure',
  async (failure) => {
    const f = await executableFixture();
    let probes = 0;
    const cli = {
      executablePath: f.path,
      run: async () => {
        probes++;
        if (probes === 1) {
          if (failure === 'missing') throw new Error('Cannot execute Git');

          return 'unknown';
        }

        return 'git version 2.47.1';
      },
    };

    if (failure === 'missing')
      await expect(readGitCapabilities(cli, 'one')).rejects.toThrow(
        'Cannot execute Git',
      );
    else
      expect((await readGitCapabilities(cli, 'one')).stableHistoryRewrite).toBe(
        false,
      );
    expect((await readGitCapabilities(cli, 'one')).stableHistoryRewrite).toBe(
      true,
    );
    expect(probes).toBe(2);
  },
);

test('unidentified executables never share cached facts', async () => {
  let version = 'git version 2.47.1';
  const cli = { run: async () => version };

  expect((await readGitCapabilities(cli, 'one')).stableHistoryRewrite).toBe(
    true,
  );
  version = 'git version 2.39.9';
  expect((await readGitCapabilities(cli, 'one')).checkAttributeSource).toBe(
    false,
  );
});

test('a cancelled probe cannot cancel or poison another caller', async () => {
  const f = await executableFixture();
  const cancel = new AbortController();
  let entered: () => void = () => {};

  let release: (version: string) => void = () => {};

  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const obsolete = new Promise<string>((resolve) => {
    release = resolve;
  });
  let probes = 0;
  const cli = {
    executablePath: f.path,
    run: async () => {
      probes++;
      if (probes === 1) {
        entered();

        return obsolete;
      }

      return 'git version 2.47.1';
    },
  };
  const first = readGitCapabilities(cli, 'one', cancel.signal);
  const outcome = first.then(
    () => 'resolved',
    (error: unknown) => error,
  );

  await started;
  cancel.abort();
  const second = await readGitCapabilities(cli, 'two');

  release('git version 2.39.9');
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  expect(second.stableHistoryRewrite).toBe(true);
  expect((await readGitCapabilities(cli, 'three')).stableHistoryRewrite).toBe(
    true,
  );
  expect(probes).toBe(2);
  await expect(
    readGitCapabilities(cli, 'two', cancel.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
});

test('does not grant support from a version read across executable replacement', async () => {
  const f = await executableFixture();
  const cli = {
    executablePath: f.path,
    run: async () => {
      const replacement = join(f.directory, 'replacement');

      await writeFile(replacement, 'changed during version probe');
      await rename(replacement, f.path);

      return 'git version 2.47.1';
    },
  };

  expect((await readGitCapabilities(cli, 'one')).stableHistoryRewrite).toBe(
    false,
  );
});
