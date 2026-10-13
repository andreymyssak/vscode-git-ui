import { readFileSync } from 'node:fs';

import { isRecord } from './validation.ts';

const manifest: unknown = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

if (
  !isRecord(manifest) ||
  typeof manifest.name !== 'string' ||
  typeof manifest.publisher !== 'string' ||
  typeof manifest.displayName !== 'string' ||
  !isRecord(manifest.engines) ||
  typeof manifest.engines.vscode !== 'string' ||
  !isRecord(manifest.contributes) ||
  !isRecord(manifest.contributes.viewsContainers) ||
  !Array.isArray(manifest.contributes.viewsContainers.panel) ||
  !isRecord(manifest.contributes.viewsContainers.panel[0]) ||
  typeof manifest.contributes.viewsContainers.panel[0].id !== 'string'
)
  throw new Error('Invalid extension identity in package.json');

export const vscodeEngine = manifest.engines.vscode;

export const extensionMetadata = Object.freeze({
  name: manifest.name,
  publisher: manifest.publisher,
  displayName: manifest.displayName,
  commandNamespace: manifest.contributes.viewsContainers.panel[0].id,
  id: `${manifest.publisher}.${manifest.name}`,
});

export const extensionDefines = {
  __EXTENSION_IDENTITY__: JSON.stringify(extensionMetadata),
};
