# Git UI

[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.txt)

**Finally, a proper Git UI for VS Code.**

Git UI is a free, focused alternative to [GitLens](https://github.com/gitkraken/vscode-gitlens) for browsing history, managing branches and worktrees, and inspecting changes. It uses familiar VS Code styling, follows your chosen theme, and opens file comparisons in VS Code's native diff editor.

Inspired by the Git tool window in JetBrains' [IntelliJ IDEA Community Edition](https://github.com/JetBrains/intellij-community).

**Completely free and open source. No subscriptions or paid tiers.**

![Demo of commit selection, opening a changed file in VS Code's diff editor, history search, and worktrees in Git UI](assets/readme/browsing.gif)

## What you can do

- **Explore history.** Browse local branches, remote branches, and tags. Filter commits by text, revision, author, or date.
- **Inspect changes.** Select a commit to see its message and files. Compare merge commits with each parent and open file diffs in the editor.
- **Trace line history.** See who changed each line and when. Open its commit in Git UI, inspect the changed files, and follow earlier changes from either side of a diff.
- **Choose what to save.** Check files in Source Control's Git UI Changes section, then commit or stash them without manually staging. Unchecked changes stay in place.
- **Browse stashes.** Inspect saved Git stashes, preview file diffs, and apply a whole stash or selected files. Restoring keeps the stash for reuse; delete it separately when finished.
- **Manage branches.** Check out, create, rename, delete, update, merge, or rebase. Restore an accidentally deleted branch from its notification.
- **Work with commits.** Cherry-pick, edit messages, squash, or drop eligible commits. Create a branch or tag from a commit.
- **Use worktrees.** Create a working folder for a branch, open it in this window or a new one, and remove it when finished.

Branch, commit, and worktree lists support multiple selection. Use VS Code's Source Control and editors to resolve conflicts.

## Fits your VS Code theme

The panel follows your VS Code theme. Here it is in Dark Modern:

![Git UI in VS Code's Dark Modern theme, showing branches, a commit graph, and changed files](assets/readme/log-dark.png)

And in Light Modern:

![Git UI in VS Code's Light Modern theme](assets/readme/log-light.png)

## Open Git UI

After installing Git UI, open a Git repository in VS Code. Show the bottom panel and select the **Git UI** tab. Your branches and commit history load automatically.

In Source Control, **Git UI Changes** has **Commit** and **Stashes** tabs. Check the files you want to save, then enter a message and commit, or use the toolbar to stash them. The Stashes tab shows saved Git stashes and their files. Clicking a file opens its diff in the editor. You can hide the built-in Changes view if you prefer Git UI.

Right-click a line number or the editor and choose **Annotate with Git Blame**. Hover an annotation, then choose **Open Commit in Git UI** to select that commit and its changed files. The same action works in historical file comparisons. Choose **Close Git Blame** to hide the annotations.

## Your repositories stay yours

Git UI has no account, cloud backend, or analytics service. Fetch connects to your configured Git remotes using VS Code's Git authentication. Optional commit message generation uses a language model configured in VS Code and sends only the checked changes to that provider when you request it. You can edit the draft before committing.

## Feedback and contributions

[Report a bug or suggest a feature](https://github.com/andreymyssak/vscode-git-ui/issues). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

For security vulnerabilities, follow the private reporting instructions in [SECURITY.md](SECURITY.md).

## License

Authored code is [MIT licensed](LICENSE.txt). Bundled Microsoft code and libraries retain their licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
