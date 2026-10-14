import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import {
  checkDeclarations,
  loadDeclarations,
  sourceRevision,
  supportedVersions,
} from '../../scripts/test/vscode-compatibility.ts';

const temporary: string[] = [];

test('uses the exact release commit and rejects mismatched update metadata', () => {
  const version = 'fcf604774b9f2674b473065736ee75077e256353';

  expect(
    sourceRevision({ productVersion: '1.125.1', version }, '1.125.1'),
  ).toBe(version);
  expect(
    sourceRevision({ productVersion: '1.142.0-insider', version }, 'insiders'),
  ).toBe(version);
  for (const metadata of [
    null,
    { productVersion: '1.141.0', version },
    { productVersion: '1.125.1', version: 'main' },
  ])
    expect(() => sourceRevision(metadata, '1.125.1')).toThrow();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('loads an untagged patch from its exact update commit without mixing declaration revisions', async () => {
  const revision = 'fcf604774b9f2674b473065736ee75077e256353';

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);

    if (url.includes('/microsoft/vscode/1.125.1/'))
      return new Response('', { status: 404 });
    if (
      url ===
      'https://update.code.visualstudio.com/api/versions/1.125.1/linux-x64/stable'
    )
      return Response.json({ productVersion: '1.125.1', version: revision });
    if (
      url ===
      `https://raw.githubusercontent.com/microsoft/vscode/${revision}/src/vscode-dts/vscode.d.ts`
    )
      return new Response('candidate SDK');
    if (
      url ===
      `https://raw.githubusercontent.com/microsoft/vscode/${revision}/extensions/git/src/api/git.d.ts`
    )
      return new Response('candidate Git API');
    throw new Error(`Unexpected source request: ${url}`);
  });
  expect(
    await loadDeclarations({ name: '1.125.1', revision: '1.125.1' }),
  ).toEqual({ revision, vscode: 'candidate SDK', git: 'candidate Git API' });
});

test('permission errors fail the source check instead of falling back to a different source', async () => {
  const request = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('', { status: 403 }));

  await expect(
    loadDeclarations({ name: '1.125.1', revision: '1.125.1' }),
  ).rejects.toThrow(/HTTP 403/);
  expect(request).toHaveBeenCalledTimes(2);
});

test('selects the floor and newest patch of each supported release series in version order', () => {
  expect(
    supportedVersions(
      [
        '1.140.0',
        '1.139.1',
        '1.139.0',
        '1.111.2',
        '1.111.0',
        '1.110.1',
        '1.9.0',
        '0.10.6-release',
        '0.10.1-preview',
      ],
      '1.111.0',
    ),
  ).toEqual(['1.111.0', '1.111.2', '1.139.1', '1.140.0']);
});

test('refuses malformed releases or a missing minimum instead of claiming coverage', () => {
  for (const releases of [
    null,
    [],
    ['1.140.0'],
    ['1.111.0', 'main'],
    ['1.111.0', 140],
  ])
    expect(() => supportedVersions(releases, '1.111.0')).toThrow();
});

test('checks host calls against the candidate SDK and rejects an incompatible Git boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-ui-compatibility-'));

  temporary.push(root);
  await mkdir(join(root, 'src/extension/git'), { recursive: true });
  const directory = join(root, 'candidate');

  await mkdir(directory);
  await writeFile(
    join(root, 'tsconfig.host.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ['vscode'],
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
      },
      include: ['src/**/*.ts'],
    }),
  );
  await mkdir(join(root, 'node_modules/@types/vscode'), { recursive: true });
  await writeFile(
    join(root, 'node_modules/@types/vscode/index.d.ts'),
    "declare module 'vscode' { export namespace window { function showInformationMessage(message: string): void; } }\n",
  );
  await writeFile(
    join(root, 'src/extension/activate.ts'),
    "import { window } from 'vscode'; window.showInformationMessage('Ready');\n",
  );
  await writeFile(
    join(root, 'src/extension/git/api.ts'),
    'export interface GitAPI { repositories: { rebase(branch: string): Promise<void> }[] }\n',
  );
  const vscodeDeclarations = join(directory, 'vscode.d.ts');
  const gitDeclarations = join(directory, 'git.d.ts');

  await writeFile(
    vscodeDeclarations,
    "declare module 'vscode' { export namespace window { function showInformationMessage(message: string): void; } }\n",
  );
  await writeFile(
    gitDeclarations,
    'export interface API { repositories: { rebase(branch: string): Promise<void> }[] }\n',
  );
  const options = { root, directory, vscodeDeclarations, gitDeclarations };

  expect(await checkDeclarations(options)).toEqual([]);

  await writeFile(
    vscodeDeclarations,
    "declare module 'vscode' { export namespace window { function anotherCommand(): void; } }\n",
  );
  expect(await checkDeclarations(options)).toContainEqual(
    expect.objectContaining({ code: 2339 }),
  );

  await writeFile(
    vscodeDeclarations,
    "declare module 'vscode' { export namespace window { function showInformationMessage(message: string): void; } }\n",
  );
  await writeFile(
    gitDeclarations,
    'export interface API { repositories: {}[] }\n',
  );
  expect(await checkDeclarations(options)).toContainEqual(
    expect.objectContaining({ code: 2322 }),
  );

  await writeFile(
    join(root, 'src/extension/git/api.ts'),
    'export interface GitAPI { repositories: { createWorktree(options?: { path?: string; noTrack?: boolean }): Promise<string> }[] }\n',
  );
  await writeFile(
    gitDeclarations,
    'export interface API { repositories: { createWorktree(options?: { path?: string }): Promise<string> }[] }\n',
  );
  expect(await checkDeclarations(options)).toContainEqual(
    expect.objectContaining({ code: 2322 }),
  );

  await writeFile(
    join(root, 'src/extension/git/api.ts'),
    'export interface GitAPI { repositories: { apply(path: string, options?: { threeWay?: boolean }): Promise<void> }[] }\n',
  );
  await writeFile(
    gitDeclarations,
    'export interface API { repositories: { apply(path: string, options?: {}): Promise<void> }[] }\n',
  );
  expect(await checkDeclarations(options)).toContainEqual(
    expect.objectContaining({ code: 2322 }),
  );
  await writeFile(
    join(root, 'src/extension/git/api.ts'),
    'export interface GitAPI { repositories: { apply(path: string, options?: { threeWay?: boolean; reverse?: boolean }): Promise<void> }[] }\n',
  );
  await writeFile(
    gitDeclarations,
    'export interface API { repositories: { apply(path: string, options?: { threeWay?: boolean }): Promise<void> }[] }\n',
  );
  expect(await checkDeclarations(options)).toContainEqual(
    expect.objectContaining({ code: 2322 }),
  );
});

test('host Node baseline rejects APIs introduced after the minimum editor runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-ui-node-baseline-'));

  temporary.push(root);
  await mkdir(join(root, 'src/extension/git'), { recursive: true });
  await symlink(
    resolve('node_modules'),
    join(root, 'node_modules'),
    'junction',
  );
  const directory = join(root, 'candidate');

  await mkdir(directory);
  await writeFile(
    join(root, 'tsconfig.host.json'),
    JSON.stringify({
      extends: resolve('tsconfig.host.json'),
      include: ['src/**/*.ts'],
    }),
  );
  await writeFile(
    join(root, 'src/extension/git/api.ts'),
    'export interface GitAPI { repositories: {}[] }\n',
  );
  await writeFile(
    join(root, 'src/extension/probe.ts'),
    "import { mkdtempDisposable } from 'node:fs/promises'; void mkdtempDisposable;\n",
  );
  const vscodeDeclarations = join(directory, 'vscode.d.ts');
  const gitDeclarations = join(directory, 'git.d.ts');

  await writeFile(vscodeDeclarations, "declare module 'vscode' {}\n");
  await writeFile(
    gitDeclarations,
    'export interface API { repositories: {}[] }\n',
  );
  expect(
    await checkDeclarations({
      root,
      directory,
      vscodeDeclarations,
      gitDeclarations,
    }),
  ).toContainEqual(expect.objectContaining({ code: 2305 }));
});
