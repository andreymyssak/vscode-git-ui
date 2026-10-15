# Architecture

Git UI has an extension host for Git access and React webviews for Log/Worktrees and Source Control's Commit/Stashes view.

## Modules

| Location                        | Responsibility                                                      |
| ------------------------------- | ------------------------------------------------------------------- |
| `src/extension/activate.ts`     | Registers the view and commands.                                    |
| `src/extension/panel/`          | Webview lifecycle, request validation and coordination.             |
| `src/extension/changes/`        | Checkbox inclusion and unsaved-file prompts.                        |
| `src/extension/source-control/` | Source Control webview, repository drafts and checked-file actions. |
| `src/extension/git/`            | Repository reads, serialized Git writes and history recovery.       |
| `src/extension/native/`         | VS Code dialogs, notifications, editors and worktree opening.       |
| `src/shared/`                   | Serializable contracts and pure models shared by host and webview.  |
| `src/webview/app/`              | Layout, host communication and saved view state.                    |
| `src/webview/pages/`            | Log, Worktrees, Commit and Stash workflows.                         |
| `src/webview/shared/`           | Reusable controls, icons and browser bridge.                        |

The webview sends requests to the extension host. The host validates their repository and targets before calling the Git adapter. Repository changes invalidate stale requests.

The Git adapter uses the installed Git extension where possible and explicit Git calls for API gaps. VS Code provides native diffs and conflict resolution. The [backend ADR](adr/0002-git-operation-backends.md) and [history recovery ADR](adr/0003-history-replay-and-recovery.md) explain those choices.

Repository consumers share one observation per repository. It coalesces metadata reads, checks again when events arrive during a read, and releases its native listener when the last consumer unsubscribes. History loads wait for pending observations before using cached history. Completed Git writes release queue ownership without waiting for observation reads.

Log actions keep progress in the panel. A spinner beside a branch covers its Git work, and a separate progress bar covers history work and data loading. Progress belongs to the repository and write request, independently of history query generations. Git writes queue in order, with waiting branches showing a clock. Captured branch updates retain their expected tip and upstream, and proceed without waiting for an earlier UI refresh. Other queued actions wait for current view handles before review. Duplicate requests are ignored until completion. Queued actions preserve displayed targets and reject changed identities, history selections or checkouts; repository switches, disposal and trust changes cancel pending intents. Writes still share the backend lock across linked worktrees. Refresh publishes references and current checkout before loading history, while retaining inactive rows until fresh history is ready. Branch write menus wait for fresh reference metadata, then unlock before the graph finishes. Repository events invalidate pending reads immediately, before the refresh debounce, so stale results cannot briefly reappear.

Divergent branch updates finish with an error notification. Its optional Checkout Branch, Rebase or Merge buttons start separate operations without fetching again. They retain the original checkout, selected branch, fetched upstream and remote configuration, and revalidate Update's safety checks before writing. Leaving a notification open does not keep Update running. Branch spinners cover branch Git work; Log and Worktrees indicators show activity in their own sections. A branch spinner stops before its resulting history refresh begins. Worktrees reads own separate activity and only the latest request can publish. Superseded refreshes promptly release their pause, deduplication and queue ownership, even when an obsolete provider read cannot be cancelled.

The Log retains its webview context when hidden, preserving loaded history and scroll position across Terminal switches. Commit navigation detaches while hidden and reconnects to the ready controller when the view becomes visible.

The branch menu and Changes title menu offer New Branch and New Branch and Checkout. Branch-menu creation starts at the selected reference; Changes-menu creation starts at HEAD. New Branch captures that checkout before its native input dialog, then revalidates it and the repository before creating through the public Git API without switching. New Branch and Checkout follows the native Git command, which uses HEAD when its write runs.

The Changes title menu offers Pull, Push, Checkout and Fetch for its selected repository, followed by native Branch and Tags submenus. Branch includes creation, checkout after creation, creation from another reference, merge, rebase, rename, deletion and publishing. Tags includes creation, local and remote deletion, and pushing. Except for create-only New Branch, these actions delegate to native Git commands. Git UI validates the repository at dispatch and holds its shared write queue until completion. VS Code then owns the pickers, authentication, confirmations and conflict handling against that original target. Repository closure invalidates queued Git UI writes; already-dispatched native commands follow VS Code's own lifecycle.

Merge Changes, Staged Changes and Changes reflect the real index and working tree. Checkboxes select whole files for Git UI Commit; partially staged files share inclusion across sections. Stage and Unstage are explicit operations and do not change inclusion. Terminal commits still use only the real index.

The Source Control view works independently of the Log webview and uses ordinary Git stashes. Selected commits and stash creation use a temporary index to exclude unchecked staged changes. Writes share the repository operation queue and a lock across linked worktrees.

Native Git status events schedule a bounded refresh of Changes. File status, stashes and operation checks publish independently for each repository, so a slow read cannot hold back ready file changes. Each publication belongs to its refresh generation; superseded reads cannot replace newer changes. A completed write releases editing and native command busy state before background status reads. Refresh activity waits for Changes and conflict state from the affected repository in the current refresh generation; stashes and other repositories do not delay it. Older reads cannot clear a newer write or refresh indicator.

The Changes toolbar shows a red Abort icon at its right edge when conflicts are present. It is disabled while another action is running. Its quick tooltip names active merges, rebases, cherry-picks, reverts or selected-file patches and explains what cancellation restores. Native Git APIs or verified commands own their cancellation. Selected-file patches use native three-way application, which has no Git sequencer to abort. Before applying a patch, Git UI records its clean target paths and checkout in that worktree's Git directory. A stopped patch retains the record across reloads; explicit Abort restores only those targets and preserves unrelated index and working-tree changes. Confirmation rejects a changed checkout, files or unsaved editor buffers. Successful application removes the record. Selected patches with overlapping file or folder paths are rejected before application; those changes require applying the whole commit, so cancellation never depends on recursively deleting a folder. Older conflicts without a record offer Discard Conflicts, restoring only conflicted files rather than guessing the original selection.

`src/extension/git/source-control/index.ts` is the commit/stash backend entry point. Its private implementation owns Git reads, prepared snapshots, live repository checks and queued writes; Source Control owns prompts, drafts and checkbox state. Prepared operations reject repositories closed or replaced during confirmation. Import checks prevent callers from accessing private backend files or using Git infrastructure directly from Source Control.

Stash names are independent of the commit draft. Applying saved files keeps the stash intact; explicitly deleting files removes their saved versions. Rename and partial deletion preserve stash order and dates through the same guarded ref/reflog writer used for stash deletion.

Blame uses native editor decorations, mouse selection events and hover links. Native selection events cannot distinguish annotation clicks from code-start clicks, and repeated clicks at the same position may emit no event. Hover links and the line commit command remain available. A shared reader owns identical pending snapshots; each editor cancels its own subscription, and the last reader releases the Git process. Tab closure releases editor state. The adapter converts displayed text with VS Code's encoding APIs while decoding Git metadata independently.

Pages own workflow UI and saved view preferences. The extension host owns per-repository Source Control drafts and checked-file state. Shared contracts contain no VS Code, Node or DOM dependencies.

Each Log/Worktrees webview creates its own browser session. The session owns its Zustand store, bridge subscription, restoration ownership and durable view persistence; React mounts and releases the subscription. Compound gestures publish one reduced snapshot before sending requests. Progress and read activity do not rewrite saved preferences. The app injects a read-only store through the Log page's public contract, and the layout, branches, history, toolbar and details select only the fields they use. Pages never import the app controller.

Log, Commit and Stashes share `src/webview/shared/ui/file-tree/` for rendering and navigation. Pages supply their files and actions.

`package.json` owns extension identity. Builds inject its name, publisher, display name and command namespace into `src/shared/extension-identity.ts`, which derives command, URI, helper and recovery identifiers. Menu payloads use domain field names without a branding prefix.

## Dependencies and generated code

React handles presentation. TanStack Virtual handles history virtualization, and Floating UI handles popovers. Styling is described in [DESIGN.md](../DESIGN.md).

Only `src/webview/pages/log/lib/graph/` imports `src/vendor/vscode-graph/`. That directory is generated from recorded upstream inputs and patches. Follow [VS Code maintenance](upstream.md) when changing it. [The graph ADR](adr/0001-graph-extraction.md) explains the extraction decision.

Build and validation scripts live in `scripts/`; tests live in `test/`. Generated reports and indexes stay in ignored `.artifacts/` and `.codegraph/`. [Development](development.md) covers setup and [testing](testing.md) covers validation.

Repository open/close events define read lifetimes even when a path stays the same. Changes refreshes carry affected repository IDs and sections; ambiguous native status events reload all sections for that repository, and manual refresh reloads every repository. Each section has its own cancellation owner, so another repository's activity cannot discard its result.

Draft typing receives a small acknowledgement with the edit identity. The host retains the canonical draft and sends full snapshots on connection and other state changes. Read-only queries use cancellable two-minute deadlines; Git writes and recovery cleanup remain awaited under their existing ownership. Native `Git UI: Show Output` logs timings and hashed correlation IDs without command arguments, file contents or commit messages.
