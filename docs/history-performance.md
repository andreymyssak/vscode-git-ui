# History cache

History uses native Git API pages of 200 commits. Optional tracking counts and highlighting arrive after rows. Navigation reuses a matching loaded prefix and defers optional metadata while discovering later pages. Restoring a deep selection publishes the completed window once. These reads still follow Git's ordering; a deep jump can require reading earlier pages.

Current-branch ancestry is streamed and shared across pages of the same snapshot. Its cache keeps a bounded prefix and requested answers rather than every ancestor. A later request beyond that prefix may need another walk. Fresh first-page queries use new ancestry ownership, even when HEAD and references stay the same. Explicit Refresh and repository invalidation also discard cached ancestry.

`gitUI.history.optimizeRepository` is enabled by default. After history loads, Git UI can update Git's local commit-graph cache in the background. This cache can speed up later history and ancestry queries. Turn the setting off in VS Code settings to prevent these writes.

The task requires Git 2.24 or later and a trusted workspace. It respects `core.commitGraph=false` and skips shallow, partial and promisor repositories. Linked worktrees share one task, with at least five minutes between attempts. Cache errors do not interrupt history browsing.

Git UI uses `git commit-graph write --reachable --split` and disables changed-path Bloom filter generation on Git versions that support it. The task does not fetch objects, run garbage collection, or change branches, the index or working files.

Reference metadata is published when it changes rather than repeated on every appended page. History scope identifiers remain constant in size even when thousands of references are selected. Large captured revision lists use standard input for CLI reads, avoiding platform argument limits while preserving snapshot ownership.

Shallow clone boundaries are part of observation and cache validity. Downloading older ancestors invalidates exhausted pages and cursors even when branch tips do not move. Unknown shallow metadata disables cache reuse. The shared boundary is observed through a nonrecursive native file watcher, including linked worktrees.

Hidden views retain invalidation and pending refresh state. Display-only refreshes coalesce until the view becomes visible again; explicit writes and their safety checks keep their normal lifecycle.

Changed Files, Changes and Stashes use the same viewport-based file tree. Only expanded rows near the visible area mount. Native menu preparation uses indexed file identity and the current selected set, avoiding a whole-file-list scan for every row. Offscreen keyboard navigation and reveal resolve through the row model before scrolling and focusing.
