# CLI Bridge Codex Plan mode

## Background / Context

Codex exposes Plan collaboration mode in its TUI (`/plan`, Shift+Tab), but
`codex exec` has no slash-command layer. In the CLI bridge today `/plan`
enters DSH plan mode and never reaches Codex, so a Codex session cannot produce
a native plan without leaving DSH.

## Goals / Approach

- Add an independent `/codex-plan <task>` command that runs one Codex
  app-server turn with `collaborationMode.mode = "plan"`.
- Persist the resulting plan in a `cliPlan` session projection so it survives a
  DSH restart.
- Show a plan bar above the composer (`cli-plan` dock) and a plan card in the
  conversation transcript (`codex-plan` command view).
- `/codex-plan approve` sends an implementation follow-up; `/codex-plan off`
  exits plan mode.
- Keep the existing print-mode turn path unchanged for ordinary prompts.

Affected files:

- `packages/cli-bridge/lib/codex-app.js` (new JSON-RPC app-server client)
- `packages/cli-bridge/lib/codex-plan-stream.js` (new plan event folding)
- `packages/cli-bridge/lib/plan.js` (new plan view/projection helpers)
- `packages/cli-bridge/lib/driver.js` (plan turn + command)
- `packages/cli-bridge/lib/index.js` (projection)
- `packages/cli-bridge/lib/client.js` (plan dock/card)
- `packages/cli-bridge/lib/backends.js` (reserved command)
- `packages/cli-bridge/test/plan.test.js`, `test/commands.test.js`,
  `test/run.mjs`
- `packages/cli-bridge/README.md`, `README.zh.md`

## Verification

- `pnpm --filter dsh-cli-bridge test`
- `pnpm --filter dsh-cli-bridge check`
- `pnpm check` from the repository root
- Direct app-server probe: `thread/start`, `turn/start` in plan mode, and
  `turn/completed` returned a plan.
- Reload the bundle and confirm `cli-plan` and `codex-plan` slots are active.

## TODO

- [x] Add app-server JSON-RPC client and plan event folding.
- [x] Add `cliPlan` projection and plan view helpers.
- [x] Register `/codex-plan` with approve/off behavior.
- [x] Add plan dock and transcript card.
- [x] Add tests and documentation.
- [x] Run package and workspace checks.
- [ ] Verify the plan bar/card in the Web GUI after a DSH restart.
