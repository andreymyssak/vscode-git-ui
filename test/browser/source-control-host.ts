import type {
  SourceControlRequest,
  SourceControlState,
} from '../../src/shared/source-control';

const sha = 'a'.repeat(40);
// A real webview receives these values from the workbench's active theme.
const theme = {
  '--vscode-sideBar-background': '#181818',
  '--vscode-sideBar-foreground': '#cccccc',
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-editorHoverWidget-background': '#202020',
  '--vscode-editorHoverWidget-foreground': '#cccccc',
  '--vscode-editorHoverWidget-border': '#454545',
  '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.36)',
  '--vscode-tree-indentGuidesStroke': '#585858',
  '--vscode-tree-inactiveIndentGuidesStroke': '#404040',
  '--vscode-widget-border': '#454545',
  '--vscode-menu-background': '#1f1f1f',
  '--vscode-menu-foreground': '#cccccc',
  '--vscode-checkbox-background': '#313131',
  '--vscode-checkbox-border': '#6b6b6b',
  '--vscode-checkbox-foreground': '#ffffff',
  '--vscode-list-inactiveSelectionBackground': '#37373d',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-button-background': '#0078d4',
  '--vscode-button-foreground': '#ffffff',
};

for (const [key, value] of Object.entries(theme))
  document.documentElement.style.setProperty(key, value);

const state: SourceControlState = {
  hoverDelay: 700,
  repositoryId: 'repo',
  tab: 'commit',
  busy: false,
  generating: false,
  reveal: null,
  repositories: [
    {
      pathLabel: { root: '~/projects/example', separator: '/' },
      info: {
        id: 'repo',
        label: 'Example repository',
        rootUri: 'file:///example',
        headSha: sha,
        branch: 'main',
      },
      checked: [],
      draft: '',
      draftEditId: null,
      commitMode: { kind: 'new' },
      changes: {
        kind: 'ready',
        items: [
          {
            path: 'src/nested/example.ts',
            originalPath: 'src/nested/example.ts',
            status: ' M',
            staged: false,
            working: true,
            untracked: false,
          },
          {
            path: 'src/new.ts',
            originalPath: 'src/new.ts',
            status: '??',
            staged: false,
            working: true,
            untracked: true,
          },
        ],
      },
      stashes: {
        kind: 'ready',
        items: [
          {
            sha,
            viewId: sha,
            base: sha,
            date: '2026-10-10T00:00:00Z',
            selector: 'stash@{0}',
            message: 'Example stash',
            files: null,
          },
        ],
      },
    },
  ],
};
let saved: unknown;
const requests: SourceControlRequest[] = [];
const publish = () =>
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { kind: 'source-control-state', state: structuredClone(state) },
    }),
  );

Reflect.set(window, 'sourceControlRequests', requests);
Reflect.set(window, 'acquireVsCodeApi', () => ({
  postMessage(request: SourceControlRequest) {
    requests.push(request);
    const repo = state.repositories[0];

    if (!repo) return;
    switch (request.kind) {
      case 'ready':
        state.tab = request.tab;
        break;
      case 'tab':
        state.tab = request.tab;
        break;
      case 'message':
        repo.draft = request.message;
        repo.draftEditId = request.editId;
        break;
      case 'check':
        repo.checked = request.checked
          ? [...new Set([...repo.checked, ...request.paths])]
          : repo.checked.filter((path) => !request.paths.includes(path));
        break;
      case 'load-stash':
        if (repo.stashes.kind === 'ready')
          for (const stash of repo.stashes.items)
            stash.files = {
              kind: 'ready',
              items: [
                {
                  path: 'src/nested/example.ts',
                  originalPath: 'src/nested/example.ts',
                  status: 'M',
                  snapshot: 'working',
                  oldRef: sha,
                  newRef: sha,
                  deleted: false,
                },
              ],
            };
        break;
      case 'generate':
        repo.draft = 'Update example behavior';
        repo.draftEditId = null;
        break;
      case 'reveal-working':
        state.reveal = {
          repositoryId: repo.info.id,
          path: 'src/nested/example.ts',
          sequence: (state.reveal?.sequence ?? 0) + 1,
        };
        break;
    }

    queueMicrotask(publish);
  },
  getState: () => saved,
  setState: (value: unknown) => {
    saved = value;
  },
}));
