# Sidebar session status colors

This bundle makes the Session list easier to scan. It does two independent things:

1. **Pins the project you are working in.** The Workspace group that owns the
   Session **running** in the main view is moved to the front of the
   Host-persisted Workspace order. Opening a finished Session never reorders
   anything; sending a new message does.
2. **Tints Session rows by state.** Every Session row gets a small state dot and a
   2 px accent bar in one of five colors.

Both features only use published extension points: the
`sidebar.session.row.trailing` and `shell.overlay` slots, the documented
`data-sidebar-list-area` / `data-row-key="session:<id>"` markers, the
`workspace/insertBefore` Workspace command, and a summary Session projection.

## State mapping

| State | Color (theme token) | Derived from |
| --- | --- | --- |
| Active | Blue — `--dsw-alias-trajectory-accent` | `SessionStatus.running` (Host fallback: `SessionSummary.running`) |
| Waiting for review | Amber — `--dsw-alias-state-warn-primary` | `SessionStatus.pendingInteraction` (approval, plan review, or a question) |
| Interrupted | Orange — `#e2811c` (plugin-owned; the palette has no orange token) | The last `turn/end` of the Session had `reason.kind` `interrupted` or `aborted` |
| Failed | Red — `--dsw-alias-state-error-primary` | The last `turn/end` of the Session had `reason.kind === 'error'` |
| Completed | Green — `--dsw-alias-state-success-primary` | `SessionStatus.completionUnread` — the turn stopped while another view had focus |
| Idle / archived | None | No dot, no tint |

Precedence is `review` → `active` → `failed` → `interrupted` → `completed` → `idle`.
Archived rows keep the shipped grayed-out look; blank rows (a fresh Session without
a first prompt) are left alone.

### Why a Host projection is needed

The Client's `SessionStatus` carries only `running`, `pendingInteraction`, and
`completionUnread`; neither it nor `SessionSummary` has a failure flag. The Host
half of this bundle registers the `sidebarSessionStatus` Session projection,
which folds `turn/end` into `{ outcome, turn }` and is published in each list
row's `projectionValues` (`wire.summary` defaults to `true`). The Client reads
`projectionValues.sidebarSessionStatus.outcome`.

Projection values arrive with list summaries, so a failed row can turn red one
list update after the failure rather than in the same frame. Only `error` counts
as a failure. A turn that ends as `interrupted` or `aborted` (Host interruption or
a cancelled turn) renders orange instead; `blocked`, `max-tokens`, and `forked`
map to the normal idle/completed logic.

## Ordering behavior

- The Workspace to lead is the one whose `sessionIds` contain the main-view
  Session (`retainedBy.mainView > 0`) **while that Session is running**. A
  running Session means a turn started, which in practice means you sent it a
  new message.
- Sessions that belong to no Workspace (the ungrouped bucket) never trigger a
  reorder.
- The reorder is a normal Host mutation: it survives restarts and is visible to
  every window connected to the same Host, exactly like a manual group drag.
- Switching the main view alone does not reorder; the move happens when that
  Session starts running, or immediately when you open a Session that is already
  running in the background.
- Reordering requires the `workspace/insertBefore` permission on that Workspace.
  Without it the effect silently does nothing, including when the Host refuses
  the command.

## Permissions

The plugin performs exactly one kind of mutating call:
`ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId)` on the Client
Workspace Controller, gated by `useWorkspaceAccess(workspaceId,
'workspace/insertBefore')`. It reads Session and Workspace snapshots but never
writes them, never opens or archives Sessions, and never touches the filesystem.

## Limitations

- The pin follows the running Session of the main view. A Host whose main-view
  Session is idle (for example right after start-up, or after a turn finished)
  leaves the order as it is until a turn starts.
- A failed turn is recolored when the next list summary arrives; a Session that
  is currently open may show the failure only in its conversation.
- Row tinting uses CSS `:has()`. On a browser engine without `:has()` support the
  dot still renders in each state color, but the row bar and background are
  omitted.
- The plugin does not add settings; the mapping above is fixed.

## Uninstall

Remove the bundle from the profile (or disable it in the Plugins list). The Host
projection unregisters with the owning fiber, and the Client removes its
stylesheet, dot seat, and overlay seat through `ctx.effect` cleanups.
