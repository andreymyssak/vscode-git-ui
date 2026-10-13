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

Repository consumers share one observation per repository. It coalesces metadata reads, checks again when events arrive during a read, and releases its native listener when the last consumer unsubscribes. History loads and completed writes wait for pending observations before using cached history.

The Source Control view works independently of the Log webview and uses ordinary Git stashes. Selected commits and stash creation use a temporary index to exclude unchecked staged changes. Writes share the repository operation queue and a lock across linked worktrees.

`src/extension/git/source-control/index.ts` is the commit/stash backend entry point. Its private implementation owns Git reads, prepared snapshots, live repository checks and queued writes; Source Control owns prompts, drafts and checkbox state. Prepared operations reject repositories closed or replaced during confirmation. Import checks prevent callers from accessing private backend files or using Git infrastructure directly from Source Control.

Stash names are independent of the commit draft. Applying saved files keeps the stash intact; explicitly deleting files removes their saved versions. Rename and partial deletion preserve stash order and dates through the same guarded ref/reflog writer used for stash deletion.

Blame uses native editor decorations, mouse selection events and hover links. Native selection events cannot distinguish annotation clicks from code-start clicks, and repeated clicks at the same position may emit no event. Hover links and the line commit command remain available. A shared reader owns identical pending snapshots; each editor cancels its own subscription, and the last reader releases the Git process. Tab closure releases editor state. The adapter converts displayed text with VS Code's encoding APIs while decoding Git metadata independently.

Pages own workflow UI and saved view preferences. The extension host owns per-repository Source Control drafts and checked-file state. Shared contracts contain no VS Code, Node or DOM dependencies.

Log, Commit and Stashes share `src/webview/shared/ui/file-tree/` for rendering and navigation. Pages supply their files and actions.

`package.json` owns extension identity. Builds inject its name, publisher, display name and command namespace into `src/shared/extension-identity.ts`, which derives command, URI, helper and recovery identifiers. Menu payloads use domain field names without a branding prefix.

## Dependencies and generated code

React handles presentation. TanStack Virtual handles history virtualization, and Floating UI handles popovers. Styling is described in [DESIGN.md](../DESIGN.md).

Only `src/webview/pages/log/lib/graph/` imports `src/vendor/vscode-graph/`. That directory is generated from recorded upstream inputs and patches. Follow [VS Code maintenance](upstream.md) when changing it. [The graph ADR](adr/0001-graph-extraction.md) explains the extraction decision.

Build and validation scripts live in `scripts/`; tests live in `test/`. Generated reports and indexes stay in ignored `.artifacts/` and `.codegraph/`. [Development](development.md) covers setup and [testing](testing.md) covers validation.
