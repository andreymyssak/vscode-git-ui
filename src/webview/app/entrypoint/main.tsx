import '@vscode/codicons/dist/codicon.css';
import '../styles/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { extensionIdentity } from '@contracts/extension-identity';
import { SourceControlPage } from '@webview/pages/source-control';
import { getSourceControlBridge, getVsCodeBridge } from '@webview/shared/api';
import { FileIconThemeProvider } from '@webview/shared/ui';

import { App } from '../layout/App';

const mount = document.getElementById('app');

if (!mount)
  throw new Error(`${extensionIdentity.displayName} root is unavailable.`);
const bridge = getVsCodeBridge();
const root = createRoot(mount);
const sourceControlBridge =
  document.body.dataset.view === 'source-control'
    ? getSourceControlBridge()
    : null;
const app = sourceControlBridge ? (
  <FileIconThemeProvider bridge={bridge}>
    <SourceControlPage bridge={sourceControlBridge} />
  </FileIconThemeProvider>
) : (
  <App bridge={bridge} />
);

root.render(__DEV__ ? <StrictMode>{app}</StrictMode> : app);

function teardown(event: PageTransitionEvent) {
  if (event.persisted) return;
  window.removeEventListener('pagehide', teardown);
  root.unmount();
  bridge.dispose();
  sourceControlBridge?.dispose();
}

window.addEventListener('pagehide', teardown);
