# Release a version

Use release-it to prepare versions and release notes. [Testing](testing.md) covers development validation. This extension is distributed as a VSIX; npm publication is disabled.

## Prepare the version

Start with a clean checkout:

```sh
npm run release:preview
npm run release:prepare
```

Preview shows the proposed version and notes without changing files. Preparation updates `package.json`, `package-lock.json`, and `CHANGELOG.md` without committing, tagging, or pushing.

Release tooling recommends the version from [Conventional Commit messages](../CONTRIBUTING.md#write-commit-messages).

Generate release entries with release-it's `conventionalcommits` preset. Publish the generated version section from `CHANGELOG.md` unchanged. The preset includes features, fixes, performance improvements, reverts, and breaking changes. Routine maintenance commits are omitted; a maintenance-only release can have no entries.

Review the final commit or squash subjects before merging using the [commit-message guidance](../CONTRIBUTING.md#write-commit-messages). Then read the entries from `release:preview` as public release text. Each entry must identify the feature and its concrete capabilities, or the behavior a fix corrects, without relying on a commit body or PR description. Add no manual introductions, feature summaries, or validation paragraphs to release notes.

With explicit approval, correct the wording of an existing entry in `CHANGELOG.md` and update the matching GitHub release from that section. Keep descriptions supported by the original changes and preserve their commit links.

To choose a version, use `npm run release:prepare -- 1.0.0`. For the first release, `npm run release:prepare -- --no-increment` keeps the current version and prepares its notes.

Review the version and generated entries, then commit the prepared files.

## Optional checks

```sh
npm run release:validate
```

This runs local, browser, native, and installed-package tests. Run it when needed; publication does not run it or require a passing CI workflow. Individual checks are listed in [testing](testing.md).

## Publish the version

Build the VSIX:

```sh
npm run package
```

This builds `.artifacts/git-ui-native.vsix` and checks its contents without running tests. Rebuild after changing the candidate.

The Marketplace publisher is `andreymyssak`; the extension identifier is `andreymyssak.git-ui-native`. Its listing URL is [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=andreymyssak.git-ui-native).

Upload the VSIX under that publisher in Marketplace management. With publishing credentials configured, publish the same package from the terminal:

```sh
npm run release:marketplace
```

To also create a GitHub release, use a clean checkout on `main` and provide `GITHUB_TOKEN` with release access:

```sh
npm run release
```

The command creates and pushes `v<version>`, creates a GitHub release, and attaches the built VSIX. It copies the prepared changelog section unchanged without running tests or waiting for CI.

Publish only with explicit authorization.
