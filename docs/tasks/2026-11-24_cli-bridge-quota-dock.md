# CLI Bridge quota dock

## Background

The quota panel exists only on the per-agent settings page. When a session runs
in a CLI agent preset, the chat page has no visible quota entry, so Codex and
Claude Code subscription quota appears to be missing.

## Goals

- Show the active CLI backend's quota at the bottom of the conversation page.
- Reuse the existing `/api/cli-bridge/quota` route and formatting.
- Keep the existing settings-page panel.
- Render only for `cli-claude-code` and `cli-codex` sessions.

## Plan

- Add a `QuotaDock` client component registered on
  `conversation.input.dock` with id `cli-quota`.
- Resolve the backend from the session `agentPreset` projection.
- Fetch quota on mount and on manual refresh; display loading/error/text.
- Add compact dock CSS using the existing theme tokens.

## Verification

- `node --check packages/cli-bridge/lib/client.js`
- `pnpm --filter dsh-cli-bridge test`
- Reload the plugin and verify the dock in a CLI session.

## TODO

- [x] Add `QuotaDock` and dock CSS.
- [x] Register it on `conversation.input.dock`.
- [x] Run syntax check and tests.
- [ ] Reload and verify in the Web GUI.
