# Testing

`npm run check` is the pre-commit gate. It runs lint, formatting, strict types, architecture checks, local Vitest projects and upstream verification.

## Test locations and commands

| Location                  | What it exercises                                                      | Command                    |
| ------------------------- | ---------------------------------------------------------------------- | -------------------------- |
| `test/unit/`              | Pure models and host workflows with controlled dependencies            | `npm run test:unit`        |
| `test/integration/`       | Disposable real Git repositories, filesystem adapters and tools        | `npm run test:integration` |
| `test/component/`         | React interactions with Testing Library in jsdom                       | `npm run test:component`   |
| `test/browser/`           | Compiled webview layout, pointer/keyboard interactions and performance | `npm run test:browser`     |
| `test/vscode/`            | Extension-host APIs, commands, native editors and Restricted Mode      | `npm run test:vscode`      |
| `test/vscode/acceptance/` | Scenarios against the installed VSIX                                   | `npm run test:installed`   |

Vitest runs unit, integration and component projects together with `npm run test:local`. Focus a run by filename, such as `npm run test:unit -- history-cache`.

Browser tests load the compiled UI in Chromium with a simulated VS Code connection. `scripts/test/browser-test-server.ts` prepares the test pages; Playwright checks layout and interactions.

Failed browser tests retain their trace and screenshot under `test-results/`, also uploaded by CI. Open a trace with `npx playwright show-trace <trace.zip>` to inspect the failing interaction.

VS Code tests run inside the desktop editor using Microsoft's `@vscode/test-cli` and `@vscode/test-electron`. Installed-extension tests install the built VSIX into an isolated profile, then run selected VS Code suites and acceptance scenarios. `scripts/test/installed-actions.ts` tests branch actions, notifications and user choices against that installed copy.

CI runs code/local tests, browser tests, native VS Code tests, and installed-package tests in parallel groups on macOS and Windows. A shared build prepares the VSIX and compiled tests once. VS Code jobs use stable. Each job reports its checks and saves results; the overall summary includes every group and fails if a required check fails or does not run.

`npm run package` builds the extension, creates its installable VSIX with Microsoft's `@vscode/vsce`, and checks the contents. `npm run test:installed` then tests that package in VS Code. Both VS Code test commands rebuild and inspect the VSIX before running.

Use `.test.ts` or `.test.tsx` for test suites and `.scenario.ts` for installed-extension scenarios. Put reusable fixtures in `test/fixtures/`. Clean up temporary files, repositories, listeners, and settings even after failure.

## Maintain tests with behavior changes

Tie each test to a current requirement and a supported production entry point. Unit tests can exercise helpers directly; verify their production callers when reviewing coverage.

| Change           | Test maintenance                                                       |
| ---------------- | ---------------------------------------------------------------------- |
| Bug fix          | Keep a regression test that reproduces the bug in the active workflow. |
| Refactor         | Preserve behavior tests; move or retarget them to the replacement.     |
| Changed behavior | Replace outdated expectations with the agreed behavior.                |
| Removed feature  | Delete obsolete tests and unused fixtures, mocks and helpers.          |

When using TDD, write a failing test for the current requirement, then implement it. If requirements change during development, update or replace the affected tests before continuing implementation. Before completion, remove tests and assertions that only record intermediate designs, rejected alternatives or superseded requirements. Apply this review to test names, fixtures and mocks too.

Keep negative assertions when they protect current requirements, including safety or compatibility. An assertion against a discarded alternative belongs in the final suite only when preventing that alternative remains an agreed requirement.

Review related coverage with each change. A passing test of unused code or an obsolete mock does not validate the current workflow. Remove retired production code with its obsolete tests. Do not leave those tests skipped or weaken assertions to make the run pass.

## Choose affected checks

| Change                    | Additional validation beyond `check`                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| Documentation             | Check edited links and commands.                                            |
| Webview UI                | Browser tests; native checks for workbench-specific behavior.               |
| Git API or native actions | Native and installed-package tests.                                         |
| Package contents          | `npm run package`; `npm run test:installed` when loading changes.           |
| Upstream graph            | Reproduction and affected graph/browser/native checks.                      |
| Agent dependencies        | Frozen installation and `npm run ai:audit`; package exclusion verification. |

Name tests for the scenario and expected outcome. Assert interactions, requests, Git state and prevented side effects. Do not add tests that merely mirror a low-impact edit or check for source text.

Use disposable repositories and fixture remotes for Git mutations. Keep logs, screenshots and one-off validation reports in `.artifacts/` or CI artifacts. Browser simulations, source analysis and native execution establish different things; report remaining platform limits accurately. [Release preparation and publication](releasing.md) run independently of these checks.
