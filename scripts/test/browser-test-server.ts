import { copyFile, mkdir, writeFile } from 'node:fs/promises';

import { build, preview } from 'vite';

const root = '.artifacts/browser-tests';

await mkdir(root, { recursive: true });
for (const fixture of [
  {
    input: 'test/browser/source-control-host.ts',
    name: 'source-control-host',
    mode: 'production',
  },
  {
    input: 'test/browser/fake-vscode-host.ts',
    name: 'fake-vscode-host',
    mode: 'production',
  },
  {
    input: 'test/browser/react-probe.tsx',
    name: 'react-probe',
    mode: 'production',
  },
  {
    input: 'src/webview/app/entrypoint/main.tsx',
    name: 'development',
    mode: 'development',
  },
]) {
  await build({
    configFile: 'vite.config.mts',
    mode: fixture.mode,
    build: {
      outDir: root,
      rolldownOptions: {
        input: fixture.input,
        output: {
          entryFileNames: `${fixture.name}.js`,
          assetFileNames: (asset) =>
            asset.names.some((name) => name.endsWith('.css'))
              ? `${fixture.name}.css`
              : '[name][extname]',
        },
      },
    },
  });
}

for (const asset of ['webview.js', 'webview.css', 'codicon.ttf'])
  await copyFile(`dist/${asset}`, `${root}/${asset}`);
await writeFile(
  `${root}/index.html`,
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="webview.css"></head><body><main id="app"></main><script src="fake-vscode-host.js"></script><script src="webview.js"></script></body></html>',
);
await writeFile(
  `${root}/react-probe.html`,
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="react-probe.css"></head><body><main id="app"></main><script src="react-probe.js"></script></body></html>',
);
await writeFile(
  `${root}/development.html`,
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="development.css"></head><body><main id="app"></main><script src="fake-vscode-host.js"></script><script src="development.js"></script></body></html>',
);
await writeFile(
  `${root}/source-control.html`,
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="webview.css"></head><body data-view="source-control"><main id="app"></main><script src="source-control-host.js"></script><script src="webview.js"></script></body></html>',
);
await preview({
  configFile: false,
  build: { outDir: root },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
