/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    ...['log', 'worktrees', 'source-control'].flatMap((page) => [
      {
        name: 'pages-do-not-import-other-pages',
        severity: 'error',
        from: { path: `^src/webview/pages/${page}/` },
        to: {
          path: '^src/webview/pages/',
          pathNot: `^src/webview/pages/${page}/`,
        },
      },
      {
        name: 'page-public-api-only',
        severity: 'error',
        from: { pathNot: `^src/webview/pages/${page}/` },
        to: {
          path: `^src/webview/pages/${page}/`,
          pathNot:
            page === 'log'
              ? '^src/webview/pages/log/(index|model)\\.ts$'
              : `^src/webview/pages/${page}/index\\.ts$`,
        },
      },
    ]),
    {
      name: 'frontend-pages-and-shared-do-not-import-app',
      severity: 'error',
      from: { path: '^src/webview/(pages|shared)/' },
      to: { path: '^src/webview/app/' },
    },
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-contracts-have-no-platform-imports',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { pathNot: '^src/shared/' },
    },
    {
      name: 'webview-has-no-host-imports',
      severity: 'error',
      from: { path: '^src/webview/' },
      to: { path: '^src/extension/|^vscode$' },
    },
    {
      name: 'webview-has-no-node-builtins',
      severity: 'error',
      from: { path: '^src/webview/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'only-graph-adapter-imports-vendor',
      severity: 'error',
      from: {
        path: '^src/',
        pathNot: '^src/webview/pages/log/lib/graph/|^src/vendor/',
      },
      to: { path: '^src/vendor/' },
    },
    {
      name: 'vendor-has-no-product-imports',
      severity: 'error',
      from: { path: '^src/vendor/' },
      to: { path: '^src/', pathNot: '^src/vendor/' },
    },
    {
      name: 'no-private-workbench-imports',
      severity: 'error',
      from: {},
      to: { path: '^vs/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(^|/)(node_modules|dist|coverage|upstream|\\.artifacts)/',
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
