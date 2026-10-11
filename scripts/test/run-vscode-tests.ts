import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
} from '@vscode/test-electron';

import { extensionMetadata } from '../shared/extension.ts';
import { isRecord } from '../shared/validation.ts';
import { runInstalledActions } from './installed-actions.ts';

function strings(value: unknown, name: string): string[] {
  assert.ok(Array.isArray(value), `Missing ${name}`);

  return value.map((item: unknown) => {
    assert.ok(typeof item === 'string', `Invalid ${name}`);

    return item;
  });
}

function prepare(label: 'installed' | 'restricted') {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('@vscode/test-cli')), 'bin.mjs');
  const preparation = spawnSync(
    process.execPath,
    [cli, '--label', label, '--list-configuration'],
    { encoding: 'utf8' },
  );

  if (preparation.error) throw preparation.error;
  if (preparation.status !== 0) throw new Error(preparation.stderr);
  const configurations: unknown = JSON.parse(preparation.stdout);

  assert.ok(Array.isArray(configurations), 'Invalid test configurations');
  const prepared: unknown = configurations[0];

  assert.ok(isRecord(prepared), `${label} test configuration not prepared`);
  assert.ok(isRecord(prepared.config), 'Missing test configuration');
  assert.ok(isRecord(prepared.env), 'Missing test environment');
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const [name, value] of Object.entries(prepared.env)) {
    assert.ok(typeof value === 'string', `Invalid environment value: ${name}`);
    env[name] = value;
  }

  delete env.ELECTRON_RUN_AS_NODE;
  assert.ok(
    typeof prepared.extensionTestsPath === 'string',
    'Missing test entry point',
  );
  const common = {
    env,
    launchArgs: strings(prepared.config.launchArgs, 'launch arguments'),
    extensionTestsPath: prepared.extensionTestsPath,
  };

  if (label === 'installed') return { kind: 'installed', ...common } as const;

  assert.ok(
    typeof prepared.config.workspaceFolder === 'string',
    'Missing restricted workspace',
  );

  return {
    kind: 'restricted',
    ...common,
    workspaceFolder: prepared.config.workspaceFolder,
    extensionDevelopmentPaths:
      typeof prepared.extensionDevelopmentPath === 'string'
        ? [prepared.extensionDevelopmentPath]
        : strings(prepared.extensionDevelopmentPath, 'development paths'),
  } as const;
}

function runWorkbench({
  executable,
  args,
  env,
  timeout,
}: {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  timeout?: number;
}): Promise<number> {
  const child = spawn(executable, args, { env, stdio: 'inherit' });
  let timedOut = false;
  const deadline =
    timeout === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeout);

  return new Promise((resolveExit, reject) => {
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(deadline);
      resolveExit(timedOut ? 1 : (code ?? 1));
    });
  });
}

const mode = process.argv[2];

assert.ok(
  mode === '--installed' || mode === '--restricted',
  'Choose --installed or --restricted',
);
const prepared = prepare(mode === '--installed' ? 'installed' : 'restricted');
const executable =
  process.env.VSCODE_EXECUTABLE_PATH ??
  (await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION ?? 'stable'));
const launchArgs = [
  ...prepared.launchArgs,
  '--disable-updates',
  '--no-cached-data',
];

if (prepared.kind === 'restricted') {
  process.exitCode = await runWorkbench({
    executable,
    args: [
      ...launchArgs,
      ...prepared.extensionDevelopmentPaths.map(
        (path) => `--extensionDevelopmentPath=${path}`,
      ),
      `--extensionTestsPath=${prepared.extensionTestsPath}`,
      '--extensions-dir',
      resolve('.artifacts/restricted-extensions'),
      prepared.workspaceFolder,
    ],
    env: prepared.env,
  });
} else {
  mkdirSync('.artifacts', { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'gnu-installed-'));

  mkdirSync(join(profile, 'User'));
  writeFileSync(
    join(profile, 'User/settings.json'),
    JSON.stringify({
      'window.menuStyle': 'custom',
      'window.dialogStyle': 'custom',
    }),
  );
  const extensions = mkdtempSync(resolve('.artifacts/installed-extensions-'));
  const cli = resolveCliPathFromVSCodeExecutablePath(executable);
  const installation = spawnSync(
    process.platform === 'win32' ? `"${cli}"` : cli,
    [
      '--install-extension',
      resolve(`.artifacts/${extensionMetadata.name}.vsix`),
      '--extensions-dir',
      extensions,
      '--user-data-dir',
      profile,
      '--force',
    ],
    {
      env: prepared.env,
      encoding: 'utf8',
      timeout: 60000,
      shell: process.platform === 'win32',
    },
  );

  if (installation.error) throw installation.error;
  if (installation.status !== 0)
    throw new Error(installation.stderr + installation.stdout);
  process.stdout.write(installation.stdout);
  const driver = mkdtempSync(resolve('.artifacts/installed-test-driver-'));

  writeFileSync(
    join(driver, 'package.json'),
    JSON.stringify({
      name: `${extensionMetadata.name}-installed-test-driver`,
      publisher: 'local-fixture',
      version: '0.0.0',
      engines: { vscode: '^1.140.0' },
    }),
  );
  const env = { ...prepared.env, GIT_UI_INSTALLED_ROOT: extensions };

  process.exitCode = await runWorkbench({
    executable,
    args: [
      ...launchArgs,
      `--extensionDevelopmentPath=${driver}`,
      `--extensionTestsPath=${prepared.extensionTestsPath}`,
      '--extensions-dir',
      extensions,
      '--user-data-dir',
      profile,
    ],
    env,
    timeout: 300000,
  });
  if (process.exitCode === 0)
    await runInstalledActions({
      executable,
      extensions,
      launchArgs: prepared.launchArgs,
      env,
    });
}
