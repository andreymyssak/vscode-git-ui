# Development

## Node and npm

Use fnm with `.node-version`. `package.json` defines the supported Node and npm versions through `devEngines`.

Install fnm with `brew install fnm` on macOS or `winget install Schniz.fnm` on Windows. See [fnm setup](https://github.com/Schniz/fnm#installation) for other shells and platforms.

For zsh, add to `~/.zshrc` and reopen the terminal:

```sh
eval "$(fnm env --use-on-cd --shell zsh)"
```

For PowerShell, add to `$PROFILE` and reopen the terminal:

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
```

From the repository root:

```sh
fnm install
fnm use
npm install --global npm@12.2.0 --ignore-scripts
npm ci
npm run check
```

CI reads the same `.node-version` through `actions/setup-node`. Development Node/npm are separate from the installed extension's VS Code runtime.

Git UI supports VS Code 1.111.0 and later compatible 1.x releases. Keep API types at or below that minimum. Run `npm run compatibility:check` to check supported release APIs and `npm run compatibility:insiders` for an early warning about Insiders changes. [Compatibility policy](testing.md#vs-code-compatibility) explains these checks and the Stable runtime suites.

## Build and run

```sh
npm run package
```

Install `.artifacts/git-ui-native.vsix` through **Extensions: Install from VSIX...**. The package command builds the extension, creates the VSIX with Microsoft's `@vscode/vsce`, and verifies its contents. Runtime assets and licenses ship through an explicit allowlist; tests, agent tools and development dependencies stay outside it.

## Try the example repository

From the project root, run:

```sh
npm run demo
```

Open the workspace path printed by the command and select **All branches** in Git UI. Each run creates a disposable repository and local remote under `.artifacts/`.

The graph includes crossed and three-parent merges, an independent history, branches, and tags. Use `examples/three-real-parents` for nonempty parent comparisons and `examples/empty-second-parent` for a valid empty comparison. The command prints their parent revisions and changed paths.

The demo also provides Update examples:

| Branch                     | Expected Update                                |
| -------------------------- | ---------------------------------------------- |
| `maintenance/behind-one`   | Fast-forward one incoming commit               |
| `maintenance/behind-five`  | Fast-forward five incoming commits             |
| `maintenance/behind-merge` | Fast-forward through history containing merges |
| `maintenance/up-to-date`   | Leave the branch unchanged                     |
| `feature/diverged`         | Require checkout and a Merge or Rebase choice  |

The output includes each maintenance branch's initial incoming and outgoing counts. Fast-forwarding creates no commit; after Update, both counts are zero. Generate a fresh workspace to repeat the examples.

## Dependencies and tooling

Use exact dependency versions, commit `package-lock.json`, and install with `npm ci`. `.npmrc` applies a two-day cooldown when resolving dependency updates and rejects unreviewed dependency install scripts.

Review scripts before approving their exact versions in `package.json` under `allowScripts`. After changing dependencies or permissions, run:

```sh
npm ci
npm install-scripts ls
npm install-scripts prune --dry-run
```

Review prune suggestions before removing entries. Keep the `fsevents` denial so clean macOS installs skip its optional native build. Run affected checks after updates.

Use `package.json` for direct tool commands. Keep TypeScript scripts for builds, test setup, fixture generation and upstream maintenance that need code. These are grouped in `scripts/build/`, `package/`, `test/`, `upstream/` and `dev/`; shared validation lives in `scripts/shared/`. Scripts run directly in Node and are included in `npm run typecheck`.

`scripts/package.json` declares ES module syntax for this folder. Dependencies, the lockfile and npm commands belong to the root package.

ESLint and Prettier enforce style. Run `npm run lint:fix` before `npm run format`. Authored TypeScript has a 700-line limit excluding comments and blank lines. Editor recommendations live in `.vscode/`.

`npm run architecture:check` checks module boundaries with dependency-cruiser and Steiger. `npm run graph` writes `.artifacts/dependencies.mmd`; regenerate it after structural changes. [Architecture](architecture.md) maps modules and [DESIGN.md](../DESIGN.md) describes styling.

Vite builds the React webview. `vite.config.mts` shares aliases and React Compiler options with Vitest and browser fixtures. esbuild bundles the Node extension host and squash helper; TypeScript checks types separately. Explicit `use no memo` directives mark imperative integrations that must remain outside automatic memoization.

Run `npm audit` during dependency maintenance to review vulnerabilities. This is a manual maintenance step, separate from CI and release validation.

Use [testing](testing.md) to choose validation and [AI setup](ai-setup.md) for agent tools.
