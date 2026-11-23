# dsh-cli-bridge

**English** | [简体中文](README.zh.md)

Run **Claude Code**, **Codex**, **Antigravity CLI**, and **CodeBuddy** sessions
from DeepSeek Harness. DSH keeps the conversation, commands, approvals, and
audit trail; the external CLI runs every turn with its own models, tools, and
sign-in.

This is an independent MIT-licensed bundle. It adapts the architecture of
[`@cocofhu/dsh-aio-agent`](https://github.com/cocofhu/dsh-aio-agent) (also MIT)
and does not share its package identity, preset ids, HTTP routes, or data.

## Agents

| Agent | Executable | Sign in | Model source |
| --- | --- | --- | --- |
| Claude Code | `claude` | `claude auth login` | built-in Claude aliases |
| Codex | `codex` | `codex login` | `~/.codex/models_cache.json` |
| Antigravity | `agy` | `agy acp --login` (or one interactive `agy` run) | `agy models` |
| CodeBuddy | `codebuddy` | `codebuddy`, then `/login` | built-in CodeBuddy aliases |

Each agent is its own plugin row, so you can enable one, several, or all of them.

## Install

Requirements: DSH with bundle support, Node.js 22+, and the CLI you want on
`PATH` (or a launch command in the settings page).

From the `dsh-plugins` monorepo root, either open **Plugins → Add plugin** and
select `packages/cli-bridge`, or run:

```powershell
dsh plugin --profile web add link:./packages/cli-bridge
```

Enable the **CLI Bridge** rows, then start a new session. Each agent's settings
page (Plugins → CLI Bridge → the agent row) shows whether the CLI is runnable,
how many models it reports, and its install/sign-in steps.

## Use

1. Open the model picker and select a model under **Claude Code**, **Codex**,
   **Antigravity**, or **CodeBuddy**. That switches the session to that agent
   preset.
2. Send a message. Every turn spawns the CLI in the session workspace, streams
   its output back into DSH, and records tool calls and results.
3. Pick a different agent or model from the picker at any time; the next turn
   uses it.

### Commands

The composer forwards commands to the running CLI:

- `/resume` — pick a previous CLI session (current workspace first). `/resume <id>`
  binds it; later turns pass `--resume`, `codex exec resume`, or
  `--conversation`.
- `/agent <line>` — send an arbitrary line to the CLI as the next prompt. Use it
  for commands or skills this plugin does not know about.
- `/quota` — show the signed-in subscription quota for Claude Code or Codex.
  Codex is read through `codex app-server` (`account/rateLimits/read`); Claude
  Code reads the OAuth usage endpoint. The settings page shows the same snapshot
  with a refresh button.
- **Verified native commands** — only commands that run in the CLI's print mode
  are registered (see the next section). Model choice stays in the DSH model
  picker, so `/model` is DSH's own command.
- **Custom commands and skills** — discovered from `.dsh/skills`,
  `.agents/skills`, `.claude/skills`, `.claude/commands`, `.cursor/skills`,
  `.codex/skills`, `.gemini/skills`, `.gemini/antigravity-cli/skills`,
  `.opencode/skills`, `.codebuddy/skills`, `.kimi/skills` (project and home).
  `/skill-name` injects the skill instructions into the prompt sent to the CLI,
  so it works even for CLIs that do not scan that directory themselves.
- **Delegation tools** — `delegate_claude_code`, `delegate_codex`,
  `delegate_antigravity`, and `delegate_codebuddy` let the DSH model hand one
  task to another CLI and get its final answer back.

### Command support

Only commands that actually run in the CLI's print mode are registered. Everything
else is still reachable through `/agent`.

| Command | Claude Code | Codex | Antigravity | CodeBuddy |
| --- | --- | --- | --- | --- |
| `/resume` | plugin | plugin | plugin | plugin |
| `/agent <line>` | plugin | plugin | plugin | plugin |
| `/quota` | subscription usage | subscription usage | — | — |
| `/cli-compact` | forwarded (verified) | — | forwarded (documented) | forwarded (documented) |
| `/config`, `/usage`, `/context`, `/cost` | forwarded (verified) | — | `/config`, `/usage`, `/context` documented | `/config`, `/context`, `/cost` documented |
| `/status`, `/skills`, `/permissions`, `/help` | **not available** in print mode | no slash-command layer in `codex exec` | documented print expansion | documented print expansion |
| `/compact` | DSH's own compaction (does not compact CLI context) | same | same | same |
| `/model` | DSH model picker | DSH model picker | DSH model picker | DSH model picker |

Details:

- **Claude Code**: probed against Claude Code 2.1.329. `/config`, `/usage`,
  `/context`, `/cost`, and `/compact` execute as local commands; `/status`,
  `/skills`, `/permissions`, and `/help` answer "isn't available in this
  environment".
- **Codex**: `exec` has no slash-command layer, so no native commands are
  registered. Skills still work because the plugin injects their content.
- **Antigravity**: the CLI documents slash-command expansion in print mode, but
  this plugin does not bundle `agy`; that list is documented rather than
  verified.
- **CodeBuddy**: 2.185.0 exposes its slash-command list in the print-mode `init`
  event. The forwarded names come from that list; execution has not been
  verified. Print mode cannot complete the interactive login: run `codebuddy`
  once and type `/login`, or set `CODEBUDDY_API_KEY` in the DSH process
  environment (add `CODEBUDDY_INTERNET_ENVIRONMENT=internal` for the China
  edition).
- **Quota**: Codex app-server returns the ChatGPT plan, its 5-hour/weekly
  windows, and lifetime/daily token usage. Claude Code reads the OAuth usage
  endpoint and appends the local `/usage` token and cache counters. Neither
  query starts a model turn. Claude Code behind a custom `ANTHROPIC_BASE_URL`
  has no subscription quota to read; `/quota` explains that and still shows the
  local token/cache line. The quota panel sits at the bottom of each settings
  page.
- `/compact` is DSH's compaction of the DSH session log. The CLI keeps its own
  context store, so use `/cli-compact` to ask the CLI to compact it (where the
  CLI supports it). `/agent /compact` does the same.

### Settings

Each agent row has:

- **Status** — runnable, model count, install/sign-in steps, and *Check again*.
- **Default model** — the model used when the session has no explicit choice.
- **Launch command** — replaces the executable; options after it are kept. Quote
  paths with spaces.
- **Approve permission requests** — `allow` auto-approves the CLI's permission
  prompts; `deny` declines. The CLI's own settings still apply to actions it
  takes without asking.

Values are saved in the profile config and apply to the next turn without a
reload.

## Diagnostics

The session log records one event per stream line and per binding under
`plugin:dsh-cli-bridge/stream`, `/permission`, `/trace`, and `/acp`. The
settings page links a diagnostic report (agent/CLI versions, argv, exit code,
stderr, recent frames) to
<https://github.com/Hsuxu/dsh-plugins/issues/new>.

## Limitations

- **Print/JSON-stream mode only.** No long-lived ACP client; each turn is one
  process.
- Built-in slash commands are forwarded to the CLI, but whether a CLI expands a
  specific built-in in headless mode is up to that CLI. Use `/agent` when in
  doubt.
- Codex and Antigravity receive images as temporary file paths; Claude Code
  receives base64 image blocks on stdin.
- DSH's composer access mode does not restrict the external CLI's own tools; the
  agent row's **Approve permission requests** setting does.
- Antigravity's CLI is not installed by this plugin. Its settings page shows the
  install command; until it is installed and signed in, its models are not
  listed. The plugin also resolves `%LOCALAPPDATA%\agy\bin\agy.exe` directly, so
  a PATH update is not required after installing it.
- `/quota` needs a real subscription login: `codex login` for Codex, and an
  OAuth `claude auth login` for Claude Code. A custom `ANTHROPIC_BASE_URL`
  (for example a local gateway) makes Claude subscription quota unavailable.

## Development

```powershell
pnpm --filter dsh-cli-bridge test   # unit tests (in-process runner)
pnpm --filter dsh-cli-bridge check
```

Layout: `lib/backends.js` (argv/env/model discovery), `lib/*-stream.js` (CLI
JSON → DSH events), `lib/turn-writer.js` (events), `lib/driver.js` (turn loop and
commands), `lib/subagent.js` (delegation), `lib/client.js` (browser UI),
`cordis.patch.yml` (rows).

## License

MIT. See [LICENSE](LICENSE) and `NOTICE` for the adapted upstream project.
