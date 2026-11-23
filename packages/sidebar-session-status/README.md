# dsh-sidebar-session-status

Pins the active project to the top of the sidebar and tints Session rows by
state: **active**, **completed**, **waiting for review**, and **failed**.

See [docs/DETAIL.md](docs/DETAIL.md) for the state mapping, ordering rules, and
limitations. The plugin row is `sidebar-session-status`; the package is
`dsh-sidebar-session-status`.

## Install

From this repository checkout:

```sh
dsh plugin --profile desktop add link:./packages/sidebar-session-status
```

Or, in the Web GUI, run the `plugin_manager` `install_bundle` action with this
package directory as the target. A rebuilt Client half needs a page refresh;
Host-side projection changes need a plugin reload or restart.

## Configuration

None. The bundle reads no environment variables and has no config keys:

- Colors come from the active theme tokens
  (`--dsw-alias-trajectory-accent`, `--dsw-alias-state-success-primary`,
  `--dsw-alias-state-warn-primary`, `--dsw-alias-state-error-primary`), so light
  and dark themes stay consistent.
- The four states are derived from Session snapshots, not configured.

## Permissions

The Client half reads Session and Workspace snapshots and calls one Workspace
mutation:

| Call | Access gate | Purpose |
| --- | --- | --- |
| `workspaces.insertBefore(workspaceId, beforeWorkspaceId)` | `workspace/insertBefore` on that Workspace | Move the active project to the front of the Host-persisted Workspace order |

The Host half only registers a session projection (`sidebarSessionStatus`, state
version `1`) that folds `turn/end` into the last turn outcome. It reads the
Session log and writes nothing. No tool, command, MCP connection, or filesystem
access is added.
