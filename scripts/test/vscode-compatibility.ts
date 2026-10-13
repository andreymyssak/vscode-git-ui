import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import { vscodeEngine } from '../shared/extension.ts';
import { isRecord } from '../shared/validation.ts';

export function sourceRevision(
  metadata: unknown,
  expectedVersion: string,
): string {
  assert.ok(
    isRecord(metadata) &&
      typeof metadata.productVersion === 'string' &&
      typeof metadata.version === 'string' &&
      /^[a-f\d]{40}$/.test(metadata.version),
    'Invalid VS Code source revision',
  );
  assert.ok(
    expectedVersion === 'insiders'
      ? /^\d+\.\d+\.\d+-insider$/.test(metadata.productVersion)
      : metadata.productVersion === expectedVersion,
    `VS Code metadata does not match ${expectedVersion}`,
  );

  return metadata.version;
}

async function declarations(revision: string) {
  const base = `https://raw.githubusercontent.com/microsoft/vscode/${revision}`;
  const [vscode, git] = await Promise.all([
    fetch(`${base}/src/vscode-dts/vscode.d.ts`, {
      signal: AbortSignal.timeout(30000),
    }),
    fetch(`${base}/extensions/git/src/api/git.d.ts`, {
      signal: AbortSignal.timeout(30000),
    }),
  ]);

  for (const response of [vscode, git])
    assert.ok(
      response.ok || response.status === 404,
      `Cannot read API declarations at ${revision}: HTTP ${response.status}`,
    );
  if (vscode.status === 404 || git.status === 404) {
    await Promise.all([vscode.body?.cancel(), git.body?.cancel()]);

    return null;
  }

  return { revision, vscode: await vscode.text(), git: await git.text() };
}

export async function loadDeclarations(target: {
  name: string;
  revision: string;
}) {
  const tagged = await declarations(target.revision);

  if (tagged) return tagged;
  assert.ok(
    target.name !== 'insiders',
    `Cannot read Insiders declarations at ${target.revision}`,
  );
  const metadata: unknown = JSON.parse(
    await fetchSource(
      `https://update.code.visualstudio.com/api/versions/${target.name}/linux-x64/stable`,
    ),
  );
  const revision = sourceRevision(metadata, target.name);
  const pinned = await declarations(revision);

  assert.ok(pinned, `Cannot read ${target.name} declarations at ${revision}`);

  return pinned;
}

function version(value: unknown) {
  assert.ok(typeof value === 'string', 'Invalid VS Code version');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);

  assert.ok(match, `Invalid VS Code version: ${value}`);

  return {
    value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function supportedVersions(
  releases: unknown,
  minimum: string,
): string[] {
  const floor = version(minimum);

  assert.ok(
    Array.isArray(releases) && releases.includes(minimum),
    'Supported minimum is absent from VS Code releases',
  );
  const series = new Map<number, ReturnType<typeof version>>();

  for (const release of releases) {
    // Microsoft's list retains pre-1.0 releases with this historical suffix.
    if (
      typeof release === 'string' &&
      /^0\.\d+\.\d+-(release|preview)$/.test(release)
    )
      continue;
    const parsed = version(release);

    if (
      parsed.major !== floor.major ||
      parsed.minor < floor.minor ||
      (parsed.minor === floor.minor && parsed.patch < floor.patch)
    )
      continue;
    const latest = series.get(parsed.minor);

    if (!latest || parsed.patch > latest.patch)
      series.set(parsed.minor, parsed);
  }

  return [
    ...new Set([
      minimum,
      ...[...series.values()]
        .sort((a, b) => a.minor - b.minor)
        .map((release) => release.value),
    ]),
  ];
}

export async function checkDeclarations({
  root,
  directory,
  vscodeDeclarations,
  gitDeclarations,
}: {
  root: string;
  directory: string;
  vscodeDeclarations: string;
  gitDeclarations: string;
}): Promise<readonly ts.Diagnostic[]> {
  const configPath = join(root, 'tsconfig.host.json');
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));

  if (config.error) return [config.error];
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    root,
    undefined,
    configPath,
  );

  if (parsed.errors.length) return parsed.errors;

  const contract = join(directory, 'git-contract.ts');
  const modulePath = (path: string) => {
    const name = relative(directory, path).replaceAll('\\', '/');

    return name.startsWith('.') ? name : `./${name}`;
  };

  await writeFile(
    contract,
    [
      `import type { API } from ${JSON.stringify(modulePath(gitDeclarations))};`,
      `import type { GitAPI } from ${JSON.stringify(modulePath(join(root, 'src/extension/git/api')))};`,
      'declare const installed: API;',
      'const supported: GitAPI = installed;',
      'void supported;',
      // Structural assignment alone permits native APIs to ignore optional keys.
      'type Local = GitAPI["repositories"][number];',
      'type Native = API["repositories"][number];',
      'type OptionKeys<F> = F extends (...args: infer A) => unknown ? NonNullable<A[0]> extends object ? keyof NonNullable<A[0]> : never : never;',
      // Worktree creation has a single options overload; fetch has multiple.
      'type WorktreeKeys<R> = R extends { createWorktree: infer F } ? OptionKeys<F> : never;',
      'type MissingOptions = Exclude<WorktreeKeys<Local>, WorktreeKeys<Native>>;',
      'const optionKeys: MissingOptions extends never ? true : false = true;',
      'void optionKeys;',
    ].join('\n'),
  );

  const program = ts.createProgram({
    rootNames: [...parsed.fileNames, contract],
    options: {
      ...parsed.options,
      // Exclude the installed SDK so it cannot fill missing candidate APIs.
      types: (parsed.options.types ?? []).filter((type) => type !== 'vscode'),
      paths: { ...parsed.options.paths, vscode: [vscodeDeclarations] },
    },
  });

  return ts.getPreEmitDiagnostics(program);
}

async function fetchSource(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });

  assert.ok(response.ok, `Cannot read ${url}: HTTP ${response.status}`);

  return response.text();
}

async function check({ name, revision }: { name: string; revision: string }) {
  const start = performance.now();
  const root = resolve('.');
  const directory = resolve('.artifacts/vscode-compatibility', name);

  await mkdir(directory, { recursive: true });
  const source = await loadDeclarations({ name, revision });
  const vscodeDeclarations = join(directory, 'vscode.d.ts');
  const gitDeclarations = join(directory, 'git.d.ts');

  await writeFile(vscodeDeclarations, source.vscode);
  await writeFile(gitDeclarations, source.git);
  const diagnostics = await checkDeclarations({
    root,
    directory,
    vscodeDeclarations,
    gitDeclarations,
  });
  const status = diagnostics.length ? 'failure' : 'success';

  if (diagnostics.length)
    process.stderr.write(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      }),
    );
  const seconds = Math.round((performance.now() - start) / 100) / 10;

  process.stdout.write(
    `${name}: ${status}, ${seconds}s, revision ${source.revision}\n`,
  );

  return { name, revision: source.revision, status, seconds };
}

async function run() {
  const args = process.argv.slice(2);

  assert.ok(
    args.length === 0 || (args.length === 1 && args[0] === '--insiders'),
    'Usage: vscode-compatibility.ts [--insiders]',
  );
  assert.ok(
    /^\^\d+\.\d+\.\d+$/.test(vscodeEngine),
    'Expected a caret VS Code minimum',
  );
  const targets = [];

  if (args[0] === '--insiders') {
    const metadata: unknown = JSON.parse(
      await fetchSource(
        'https://update.code.visualstudio.com/api/update/linux-x64/insider/latest',
      ),
    );

    targets.push({
      name: 'insiders',
      revision: sourceRevision(metadata, 'insiders'),
    });
  } else {
    const releases: unknown = JSON.parse(
      await fetchSource(
        'https://update.code.visualstudio.com/api/releases/stable',
      ),
    );

    targets.push(
      ...supportedVersions(releases, vscodeEngine.slice(1)).map((release) => ({
        name: release,
        revision: release,
      })),
    );
  }

  const results = [];

  for (const target of targets) results.push(await check(target));
  const reportPath = resolve(
    `.artifacts/vscode-compatibility-${args.length ? 'insiders' : 'stable'}.json`,
  );

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify({ engine: vscodeEngine, results }, null, 2),
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '## VS Code API compatibility',
        '',
        '| Version | Revision | API check | Seconds |',
        '| --- | --- | --- | --- |',
        ...results.map(
          (result) =>
            `| ${result.name} | ${result.revision} | ${result.status} | ${result.seconds} |`,
        ),
        '',
        'Checks authored host code and the public Git API contract. Runtime suites run on Stable.',
        '',
      ].join('\n'),
    );
  process.exitCode = results.some((result) => result.status === 'failure')
    ? 1
    : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await run();
}
