# Changelog

## [0.4.0](https://github.com/andreymyssak/vscode-git-ui/compare/v0.3.2...v0.4.0) (2026-10-14)

### Features

- add Pull, Push, Fetch, Branch, and Tags actions to Git UI Changes with separate branch creation and checkout ([df24728](https://github.com/andreymyssak/vscode-git-ui/commit/df24728e2d05a1e8479795f7f8187ffa844932e5))
- **log:** cherry-pick or revert selected files from commit history ([d6aebd4](https://github.com/andreymyssak/vscode-git-ui/commit/d6aebd4942b4140548da829a8229e2cb09527493))
- **source-control:** stage files, resolve conflicts, move files to Trash, and abort operations ([7d1507d](https://github.com/andreymyssak/vscode-git-ui/commit/7d1507d3e272102a1a9c12ac078de31e21b79389))

### Bug Fixes

- **branches:** explain broken worktrees when Update cannot safely check branch use ([f932a8f](https://github.com/andreymyssak/vscode-git-ui/commit/f932a8f3c107f871da48635a17f5f942c6b38d5e))
- **log:** remove empty graph spacing while keeping Author and Date aligned ([221e806](https://github.com/andreymyssak/vscode-git-ui/commit/221e8066669f58797facc8bf6262a21d058a66a5))
- **source-control:** keep actions disabled until the latest status refresh finishes ([c986df0](https://github.com/andreymyssak/vscode-git-ui/commit/c986df0de1af6e2a80498a4637470bf0f450aedd))
- **source-control:** wait for toolbar updates before opening native Git pickers ([c93ce04](https://github.com/andreymyssak/vscode-git-ui/commit/c93ce04242402b98ee69e170e1b6886bea7295d7))

## [0.3.2](https://github.com/andreymyssak/vscode-git-ui/compare/v0.3.1...v0.3.2) (2026-10-13)

### Bug Fixes

- **accessibility:** expose commit positions and honor VS Code Reduce Motion ([8d7ced3](https://github.com/andreymyssak/vscode-git-ui/commit/8d7ced3e0ff58488404e85d6ce131690fbe35692))
- **compatibility:** support VS Code 1.111 and later 1.x releases ([cb419c5](https://github.com/andreymyssak/vscode-git-ui/commit/cb419c5b1f40ba7758fbbeb68ea41247582ce79a))
- **git:** open repositories with trailing whitespace in folder names ([b3f08e9](https://github.com/andreymyssak/vscode-git-ui/commit/b3f08e9d7616427d4e82fe01ceb9b84e7f6f1cef))

### Performance Improvements

- **log:** coalesce repository changes to keep history refreshes responsive ([6254481](https://github.com/andreymyssak/vscode-git-ui/commit/62544814916f3bc447b41ae4cc15329653f158ff))

## [0.3.1](https://github.com/andreymyssak/vscode-git-ui/compare/v0.3.0...v0.3.1) (2026-10-12)

### Bug Fixes

- **blame:** open line commits with mouse clicks on dates and authors ([198d109](https://github.com/andreymyssak/vscode-git-ui/commit/198d109071c1170a574d50ae3256bcfde88bf56e))
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
