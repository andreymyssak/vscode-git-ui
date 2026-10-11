import type { SourceControlBridge } from '@contracts/source-control';

import type { SourceControlWebviewApi } from '../source-control-bridge';
import { createSourceControlBridge } from '../source-control-bridge';
import type { BrowserBridge, WebviewApi } from './messages';
import { createBrowserBridge } from './messages';

declare function acquireVsCodeApi(): WebviewApi & SourceControlWebviewApi;
let api: (WebviewApi & SourceControlWebviewApi) | undefined;
let bridge: BrowserBridge | undefined;
let sourceControlBridge: SourceControlBridge | undefined;

function getApi() {
  api ??= acquireVsCodeApi();

  return api;
}

export function getVsCodeBridge(): BrowserBridge {
  bridge ??= createBrowserBridge(getApi(), window);

  return bridge;
}

export function getSourceControlBridge(): SourceControlBridge {
  sourceControlBridge ??= createSourceControlBridge(getApi(), window);

  return sourceControlBridge;
}
