# Changelog

## [0.3.1](https://github.com/andreymyssak/vscode-git-ui/compare/v0.3.0...v0.3.1) (2026-10-11)

### Bug Fixes

- **blame:** preserve file encodings and keep annotations with their editor tabs ([c56653b](https://github.com/andreymyssak/vscode-git-ui/commit/c56653b919dc91901f8986428dab554167a49cd9))
- **branches:** keep horizontally scrolled names visible while filtering ([f4bbab1](https://github.com/andreymyssak/vscode-git-ui/commit/f4bbab1f775620cae105c9c80ae3e22fcd86dc76))
- **git:** order writes across linked worktrees and cancel abandoned action checks ([7efd073](https://github.com/andreymyssak/vscode-git-ui/commit/7efd0736b5703b931e9163518e98aa855051e2b0))
- **log:** retry failed history pages and reuse repeated changed-file comparisons ([0e0aabc](https://github.com/andreymyssak/vscode-git-ui/commit/0e0aabc99eccceaf42947cb595c0e2978f727590))

### Performance Improvements

- **log:** keep large histories responsive when older commits cannot be edited ([878494b](https://github.com/andreymyssak/vscode-git-ui/commit/878494b0a5b25707fe3055bc27f60c733cb96e76))

## [0.3.0](https://github.com/andreymyssak/vscode-git-ui/compare/v0.2.0...v0.3.0) (2026-10-11)

### Features

- add Git Blame annotations in the editor with authors, dates, and links to commits and changed files ([8e13cc7](https://github.com/andreymyssak/vscode-git-ui/commit/8e13cc7f21aaba3c22f5cf1cc1030dd54df31eda))

## [0.2.0](https://github.com/andreymyssak/vscode-git-ui/compare/v0.1.3...v0.2.0) (2026-10-11)

### Features

- Add Git UI Changes with file checkboxes, an inline commit editor, and browsable stashes ([a335286](https://github.com/andreymyssak/vscode-git-ui/commit/a335286bb43bfdc9cc11d357bef1e4d1de7b2e30)).

## [0.1.3](https://github.com/andreymyssak/vscode-git-ui/compare/v0.1.2...v0.1.3) (2026-10-10)

### Bug Fixes

- Complete the Git UI rename across commands and file comparisons ([ecb6607](https://github.com/andreymyssak/vscode-git-ui/commit/ecb6607793dbe7c9b1abe3ae7cbb8d3493389dba)).

## [0.1.2](https://github.com/andreymyssak/vscode-git-ui/compare/v0.1.1...v0.1.2) (2026-10-10)

### Bug Fixes

- Rename Git Native UI to Git UI and change the Marketplace identifier to `andreymyssak.git-ui-native` ([7c1281b](https://github.com/andreymyssak/vscode-git-ui/commit/7c1281b00d079575d91a9e3e39c85658a061c341)).

## [0.1.1](https://github.com/andreymyssak/vscode-git-ui/compare/v0.1.0...v0.1.1) (2026-10-10)

### Bug Fixes

- Fix publishing maintenance releases that have no changelog entries ([bb812c7](https://github.com/andreymyssak/vscode-git-ui/commit/bb812c7b1583bf4ebd7be2c3c03217e1f4a86e91)).

## 0.1.0 (2026-10-09)

Initial public release.

- Browse Git history with a themed commit graph and text, author, and date filters.
- Inspect changed files and merge parents, with comparisons in VS Code's native diff editor.
- Create, switch, rename, merge, and rebase branches, and restore accidentally deleted branches.
- Cherry-pick eligible commits, edit their messages, squash them, or drop them.
- Create, open, and remove Git worktrees.
