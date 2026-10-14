import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { defineConfig } from '@vscode/test-cli';

mkdirSync('.artifacts', { recursive: true });
const gitConfig = resolve('.artifacts/test-global.gitconfig');

writeFileSync(gitConfig, '');
const base = {
  env: {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_UI_TEST_ARTIFACTS: resolve('.artifacts'),
  },
  version: process.env.VSCODE_TEST_VERSION ?? 'stable',
  platform: 'desktop',
  ...(process.env.VSCODE_EXECUTABLE_PATH
    ? { useInstallation: { fromPath: process.env.VSCODE_EXECUTABLE_PATH } }
    : {}),
  launchArgs: [
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    '--disable-gpu',
  ],
  mocha: {
    ui: 'bdd',
    timeout: 30000,
    reporter: process.env.CI ? 'json-stream' : 'spec',
  },
};
const nativeMocha = {
  ...base.mocha,
  require: resolve('dist/test/fixtures/native-setup.cjs'),
};

const untrustedProfile = mkdtempSync(join(tmpdir(), 'gnu-trust-'));
const nativeProfile = mkdtempSync(join(tmpdir(), 'gnu-native-'));
const untrustedWorkspace = resolve('.artifacts/untrusted-workspace');
const nativeWorkspace = mkdtempSync(resolve('.artifacts/native-workspace-'));

mkdirSync(untrustedWorkspace, { recursive: true });
mkdirSync(join(nativeProfile, 'User'));
writeFileSync(
  join(nativeProfile, 'User/settings.json'),
  JSON.stringify({
    'window.menuStyle': 'custom',
    'window.dialogStyle': 'custom',
  }),
);
mkdirSync(resolve(untrustedProfile, 'User'), { recursive: true });
writeFileSync(
  resolve(untrustedProfile, 'User/settings.json'),
  JSON.stringify({
    'security.workspace.trust.enabled': true,
    'security.workspace.trust.emptyWindow': false,
    'security.workspace.trust.startupPrompt': 'never',
  }),
);
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();

  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();

    if (!address || typeof address === 'string')
      return reject(new Error('No debug port'));
    server.close(() => resolvePort(address.port));
  });
});

export default defineConfig([
  {
    ...base,
    label: 'native',
    mocha: nativeMocha,
    workspaceFolder: nativeWorkspace,
    files: 'dist/test/vscode/*.test.cjs',
    env: { ...base.env, VSCODE_TEST_DEBUG_PORT: String(port) },
    launchArgs: [
      ...base.launchArgs,
      '--user-data-dir',
      nativeProfile,
      `--remote-debugging-port=${port}`,
    ],
  },
  {
    ...base,
    label: 'installed',
    mocha: nativeMocha,
    files: [
      'dist/test/vscode/package.test.cjs',
      'dist/test/vscode/accessibility.test.cjs',
      'dist/test/vscode/blame.test.cjs',
      'dist/test/vscode/blame-documents.test.cjs',
      'dist/test/vscode/blame-native-editor.test.cjs',
      'dist/test/vscode/blame-layout.test.cjs',
      'dist/test/vscode/blame-hover-navigation.test.cjs',
      'dist/test/vscode/changes-stashes.test.cjs',
      'dist/test/vscode/stash-editing.test.cjs',
      'dist/test/vscode/change-menus.test.cjs',
      'dist/test/vscode/commit-menu.test.cjs',
      'dist/test/vscode/selected-commit-changes.test.cjs',
      'dist/test/vscode/history-editing.test.cjs',
      'dist/test/vscode/branch-restore.test.cjs',
      'dist/test/vscode/notifications.test.cjs',
      'dist/test/vscode/log-notifications.test.cjs',
      'dist/test/vscode/history-events.test.cjs',
      'dist/test/vscode/file-activation.test.cjs',
      'dist/test/vscode/file-latency.test.cjs',
      'dist/test/vscode/graph-interaction.test.cjs',
      'dist/test/vscode/branch-selection.test.cjs',
      'dist/test/vscode/parent-comparisons.test.cjs',
      'dist/test/vscode/header-controls.test.cjs',
      'dist/test/vscode/worktrees.test.cjs',
    ],
    env: { ...base.env, VSCODE_TEST_DEBUG_PORT: String(port) },
    launchArgs: [
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--disable-gpu',
      `--remote-debugging-port=${port}`,
    ],
  },
  {
    ...base,
    label: 'restricted',
    workspaceFolder: untrustedWorkspace,
    files: 'dist/test/vscode/restricted/*.test.cjs',
    launchArgs: [
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-gpu',
      '--user-data-dir',
      untrustedProfile,
    ],
  },
]);
