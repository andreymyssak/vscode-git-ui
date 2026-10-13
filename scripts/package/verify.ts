import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import type { Metafile } from 'esbuild';
import yauzl from 'yauzl';

import { extensionMetadata, vscodeEngine } from '../shared/extension.ts';
import { isRecord } from '../shared/validation.ts';

const allowed = new Set([
  'extension/package.json',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt',
  'extension/THIRD_PARTY_NOTICES.md',
  'extension/assets/git-ui-native.svg',
  'extension/assets/marketplace-icon.png',
  'extension/dist/extension.cjs',
  'extension/dist/squash-helper.cjs',
  'extension/dist/webview.js',
  'extension/dist/webview.css',
  'extension/dist/codicon.ttf',
  'extension/dist/UI_LICENSES.txt',
  'extension.vsixmanifest',
  '[Content_Types].xml',
]);

type BundleImport = Required<
  Pick<Metafile['inputs'][string]['imports'][number], 'path' | 'external'>
>;

type BundleOutput = Pick<Metafile['outputs'][string], 'entryPoint'> & {
  imports: BundleImport[];
};

type HelperMetafile = {
  inputs: Map<string, BundleImport[]>;
  outputs: Map<string, BundleOutput>;
};

function parseInputPaths(value: unknown, label: string): string[] {
  assert.ok(isRecord(value), `Invalid ${label} build metafile`);
  assert.ok(isRecord(value.inputs), `Invalid ${label} build inputs`);

  return Object.keys(value.inputs).map((path) => path.replaceAll('\\', '/'));
}

function parseSourcePaths(value: unknown): string[] {
  assert.ok(isRecord(value), 'Invalid webview source map');
  assert.ok(Array.isArray(value.sources), 'Invalid webview source paths');

  return value.sources.map((path: unknown) => {
    assert.ok(typeof path === 'string', 'Invalid webview source path');

    return path.replaceAll('\\', '/');
  });
}

function parseBundleImports(value: unknown, label: string): BundleImport[] {
  assert.ok(isRecord(value), `Invalid ${label} build record`);
  const imports: unknown = value.imports ?? [];

  assert.ok(Array.isArray(imports), `Invalid ${label} build imports`);

  return imports.map((imported: unknown) => {
    assert.ok(isRecord(imported), `Invalid ${label} build import`);
    assert.ok(
      typeof imported.path === 'string',
      `Invalid ${label} import path`,
    );
    assert.ok(
      imported.external === undefined || typeof imported.external === 'boolean',
      `Invalid ${label} external import flag`,
    );

    return { path: imported.path, external: imported.external ?? false };
  });
}

function parseHelperMetafile(value: unknown): HelperMetafile {
  assert.ok(isRecord(value), 'Invalid squash helper build metafile');
  const inputRecords: unknown = value.inputs ?? {};
  const outputRecords: unknown = value.outputs ?? {};

  assert.ok(isRecord(inputRecords), 'Invalid squash helper build inputs');
  assert.ok(isRecord(outputRecords), 'Invalid squash helper build outputs');
  const inputs = new Map<string, BundleImport[]>();
  const outputs = new Map<string, BundleOutput>();

  for (const [path, input] of Object.entries(inputRecords))
    inputs.set(path, parseBundleImports(input, `squash helper input ${path}`));
  for (const [path, output] of Object.entries(outputRecords)) {
    assert.ok(isRecord(output), `Invalid squash helper output ${path}`);
    const imports = parseBundleImports(output, `squash helper output ${path}`);
    const entryPoint = output.entryPoint;

    assert.ok(
      entryPoint === undefined ||
        entryPoint === null ||
        typeof entryPoint === 'string',
      `Invalid squash helper output entry point: ${path}`,
    );
    outputs.set(
      path,
      entryPoint == null ? { imports } : { imports, entryPoint },
    );
  }

  return { inputs, outputs };
}

function requiredFile(contents: Map<string, Buffer>, path: string): Buffer {
  const content = contents.get(path);

  assert.ok(content, `Missing ${path}`);
  assert.ok(content.length, `Empty ${path}`);

  return content;
}

export function verifyReleaseManifest(manifest: unknown): void {
  assert.ok(isRecord(manifest), 'Invalid release manifest');
  assert.equal(
    manifest.name,
    extensionMetadata.name,
    'Release extension name must match package.json',
  );
  assert.equal(
    manifest.publisher,
    extensionMetadata.publisher,
    'Release publisher must match package.json',
  );
  assert.ok(
    typeof manifest.version === 'string',
    'Release version must be a nonzero stable semantic version',
  );
  assert.match(
    manifest.version ?? '',
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
    'Release version must be a nonzero stable semantic version',
  );
  assert.notEqual(manifest.version, '0.0.0', 'Release version must be nonzero');
  assert.equal(manifest.license, 'MIT', 'Release license must be MIT');
  assert.equal(
    manifest.icon,
    'assets/marketplace-icon.png',
    'Release icon must use the packaged PNG',
  );
  assert.deepEqual(
    manifest.repository,
    {
      type: 'git',
      url: 'https://github.com/andreymyssak/vscode-git-ui.git',
    },
    'Release repository must identify the intended personal source repository',
  );
  assert.equal(
    manifest.homepage,
    'https://github.com/andreymyssak/vscode-git-ui#readme',
    'Release homepage must link to project documentation',
  );
  assert.equal(
    isRecord(manifest.bugs) ? manifest.bugs.url : undefined,
    'https://github.com/andreymyssak/vscode-git-ui/issues',
    'Release bugs URL must identify the issue tracker',
  );
  assert.ok(
    Array.isArray(manifest.keywords) &&
      manifest.keywords.length &&
      manifest.keywords.every(
        (keyword: unknown) => typeof keyword === 'string' && keyword.trim(),
      ),
    'Release keywords must describe the extension',
  );
}

export function verifySquashHelperInputs(value: unknown): void {
  const helper = parseHelperMetafile(value);
  const paths = [...helper.inputs.keys()].map((path) =>
    path.replaceAll('\\', '/'),
  );
  const outputs = [...helper.outputs.entries()];

  assert.ok(
    paths.includes('src/extension/git/squash-helper.ts'),
    'Squash helper entry point is missing from its bundle inputs',
  );
  assert.ok(
    outputs.some(
      ([path, output]) =>
        path.replaceAll('\\', '/') === 'dist/squash-helper.cjs' &&
        output.entryPoint?.replaceAll('\\', '/') ===
          'src/extension/git/squash-helper.ts',
    ),
    'Squash helper bundle must have its separate entry point',
  );

  for (const path of paths) {
    assert.ok(
      !('/' + path).includes('/node_modules/'),
      `Squash helper dependency/tooling input: ${path}`,
    );
    assert.ok(
      !/\.development\./.test(path),
      `Squash helper development input: ${path}`,
    );
  }

  const importsToCheck = [
    // esbuild records object-valued defines as virtual input imports. Their
    // values are bundled; output imports still require real Node builtins.
    ...Array.from(helper.inputs.values(), (imports) =>
      imports.filter(
        (imported) => imported.path !== '<define:__EXTENSION_IDENTITY__>',
      ),
    ),
    ...Array.from(helper.outputs.values(), (output) => output.imports),
  ];

  for (const imports of importsToCheck) {
    for (const imported of imports) {
      if (!imported.external) continue;

      const module = imported.path.startsWith('node:')
        ? imported.path.slice(5)
        : imported.path;

      assert.ok(
        builtinModules.includes(module),
        `Squash helper external runtime must be a Node builtin: ${imported.path}`,
      );
    }
  }
}

export function verifyBuildInputs(host: unknown, webview: unknown): void {
  const hostInputs = parseInputPaths(host, 'host');
  const uiInputs = parseSourcePaths(webview);

  assert.ok(
    !hostInputs.some((path) =>
      /\/node_modules\/(?:react|react-dom|scheduler|zustand|clsx|tabbable|@tanstack\/(?:react-virtual|virtual-core)|@floating-ui\/(?:react|react-dom|dom|core|utils))\//.test(
        '/' + path,
      ),
    ),
    'Host inputs must not contain React or webview UI libraries',
  );
  for (const path of [...hostInputs, ...uiInputs]) {
    assert.ok(!/\.development\./.test(path), `Development input: ${path}`);
    assert.ok(
      !/\/node_modules\/(?:@vitejs|vite|vitest|@vitest|@testing-library|react-devtools|@babel|@rolldown|babel-plugin-react-compiler|eslint-plugin-react-hooks|eslint-plugin-simple-import-sort|@stylistic)(?:\/|-)/.test(
        '/' + path,
      ),
      `Test/development tooling input: ${path}`,
    );
  }

  for (const path of [
    'react/cjs/react.production.js',
    'react/cjs/react-jsx-runtime.production.js',
    'react-dom/cjs/react-dom-client.production.js',
    'scheduler/cjs/scheduler.production.js',
    'react/cjs/react-compiler-runtime.production.js',
  ])
    assert.ok(
      uiInputs.some(
        (input) =>
          input.endsWith('/node_modules/' + path) ||
          input === 'node_modules/' + path,
      ),
      `Missing ${path} production input`,
    );
}

export function verifyUiLicenses(text: string): void {
  for (const path of [
    'react/LICENSE',
    'react-dom/LICENSE',
    'scheduler/LICENSE',
    '@floating-ui/react/LICENSE',
    '@tanstack/react-virtual/LICENSE',
    'zustand/LICENSE',
    'clsx/license',
    'jsonc-parser/LICENSE.md',
    'picomatch/LICENSE',
  ]) {
    const section = text
      .split(`${path}\n\n`)[1]
      ?.split(/\n\n[^\n]+\/(?:LICENSE(?:-CODE)?(?:\.md)?|license)\n\n/)[0];

    assert.ok(
      section?.includes('Permission is hereby granted') &&
        section.includes('THE SOFTWARE IS PROVIDED'),
      `Missing ${path} license text`,
    );
  }
}

export async function verifyPackage(vsixPath: string): Promise<void> {
  const [host, webview, helper] = await Promise.all([
    readFile('.artifacts/build-host.json', 'utf8'),
    readFile('dist/webview.js.map', 'utf8'),
    readFile('.artifacts/build-squash-helper.json', 'utf8'),
  ]);

  const hostMetafile: unknown = JSON.parse(host);
  const webviewSourceMap: unknown = JSON.parse(webview);
  const helperMetafile: unknown = JSON.parse(helper);

  verifyBuildInputs(hostMetafile, webviewSourceMap);
  verifySquashHelperInputs(helperMetafile);
  const contents = await new Promise<Map<string, Buffer>>(
    (resolveContents, reject) => {
      yauzl.open(
        vsixPath,
        { lazyEntries: true },
        (error, zip: yauzl.ZipFile | undefined) => {
          if (error) return reject(error);
          if (!zip)
            return reject(new Error('VSIX reader did not return a ZIP file'));
          const files = new Map<string, Buffer>();

          zip.on('error', reject);
          zip.on('end', () => resolveContents(files));
          zip.on('entry', (entry: yauzl.Entry) => {
            if (!allowed.has(entry.fileName)) {
              zip.close();

              return reject(
                new Error(`Unexpected packaged file: ${entry.fileName}`),
              );
            }

            if (entry.uncompressedSize > 2 * 1024 * 1024) {
              zip.close();

              return reject(
                new Error(`Unexpected oversized file: ${entry.fileName}`),
              );
            }

            if (files.has(entry.fileName)) {
              zip.close();

              return reject(
                new Error(`Duplicate packaged file: ${entry.fileName}`),
              );
            }

            zip.openReadStream(
              entry,
              (streamError, stream: Readable | undefined) => {
                if (streamError) {
                  zip.close();

                  return reject(streamError);
                }

                if (!stream) {
                  zip.close();

                  return reject(
                    new Error(
                      `VSIX reader did not return a file stream: ${entry.fileName}`,
                    ),
                  );
                }

                const buffers: Buffer[] = [];

                stream.on('error', reject);
                stream.on('data', (data: unknown) => {
                  if (!Buffer.isBuffer(data)) {
                    stream.destroy();
                    zip.close();

                    return reject(
                      new Error(`Unexpected ZIP file data: ${entry.fileName}`),
                    );
                  }

                  buffers.push(data);
                });
                stream.on('end', () => {
                  files.set(entry.fileName, Buffer.concat(buffers));
                  zip.readEntry();
                });
              },
            );
          });
          zip.readEntry();
        },
      );
    },
  );
  const zipEntries = [...contents.keys()];

  assert.ok(zipEntries.includes('extension/dist/extension.cjs'));
  assert.ok(!zipEntries.some((path) => path.startsWith('extension/upstream/')));
  for (const path of allowed) {
    requiredFile(contents, path);
  }

  const manifest: unknown = JSON.parse(
    requiredFile(contents, 'extension/package.json').toString('utf8'),
  );

  verifyReleaseManifest(manifest);
  assert.ok(isRecord(manifest), 'Invalid packaged release manifest');

  assert.equal(manifest.main, './dist/extension.cjs');
  assert.ok(isRecord(manifest.engines), 'Invalid packaged extension engines');
  assert.equal(manifest.engines.vscode, vscodeEngine);
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.extensionDependencies, ['vscode.git']);
  if (manifest.enabledApiProposals != null) {
    assert.ok(
      Array.isArray(manifest.enabledApiProposals),
      'Invalid proposed API list',
    );
    assert.ok(!manifest.enabledApiProposals.length);
  }

  const license = requiredFile(contents, 'extension/LICENSE.txt').toString(
    'utf8',
  );

  assert.match(license, /MIT License/);
  assert.match(license, /Permission is hereby granted/);
  assert.match(license, /THE SOFTWARE IS PROVIDED/);
  const icon = requiredFile(contents, 'extension/assets/marketplace-icon.png');

  assert.deepEqual(
    icon.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  assert.ok(
    icon.readUInt32BE(16) >= 128 && icon.readUInt32BE(20) >= 128,
    'Marketplace icon must be at least 128 pixels in both dimensions',
  );
  // Bundled dependency metadata is allowed; ZIP entries and build inputs enforce isolation.
  const notice = requiredFile(
    contents,
    'extension/THIRD_PARTY_NOTICES.md',
  ).toString('utf8');

  assert.match(notice, /Copyright.*Microsoft/);
  assert.match(notice, /Permission is hereby granted/);
  assert.match(notice, /THE SOFTWARE IS PROVIDED/);
  const uiNotices = requiredFile(
    contents,
    'extension/dist/UI_LICENSES.txt',
  ).toString('utf8');

  verifyUiLicenses(uiNotices);
  console.log(
    `Verified ${zipEntries.length} VSIX files; runtime assets/notices present, development files excluded.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await verifyPackage(
    resolve(process.argv[2] ?? `.artifacts/${extensionMetadata.name}.vsix`),
  );
