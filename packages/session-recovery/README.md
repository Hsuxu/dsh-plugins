# dsh-session-recovery

A system-maintenance plugin for DeepSeek Harness. After DSH starts, it looks for
conversations whose last turn never finished — a crash, a forced exit, a model
call that failed, or a turn you stopped before quitting — and resumes them so the
work continues without you reopening every session by hand.

## What it does

On each of a few scan windows after boot (4s, 15s, 30s, 60s):

1. Lists every persisted session and skips the ones that belong to a subagent,
   were archived, or whose working directory is gone. Sessions that DSH already
   restored are kept: they are resumed but idle, which is exactly the state this
   plugin is meant to continue.
2. Reads the tail of each log and classifies the last turn:
   - no `turn/end` after its `turn/start` — the process died mid-turn;
   - the turn ended as `interrupted`, or as `aborted` with the `disposed` cause —
     DSH quit while it ran;
   - the turn ended with `error` from the model provider, unless the code is one
     a restart cannot fix (auth, quota, invalid request);
   - the turn was aborted by you (`user`), when `includeUserAborted` is on — a
     session you stopped and then left behind.
   A turn that completed, was cut off by `max-tokens`, or ended for another
   reason is left alone.
3. Resumes the session through the ordinary session controller, so its agent
   preset, model selection, and working directory are restored exactly as the
   Web app would restore them. An agent that is already live is reused instead of
   resolved again, and an agent that is still running is never interrupted.
4. Queues one follow-up user message that names the interruption and asks the
   model to continue from where it stopped. The message is prefixed with
   `[session-recovery]` so later rescans can recognize it.

Sessions that keep failing are retried at most `maxAttempts` times across
restarts, only turns that ended within `recentWindowMinutes` are considered, and
only `maxSessions` sessions are resumed in one boot. If a pass cannot reach the
host services or list sessions, it retries at the next scan window.

Every pass writes its decisions to
`$DSH_HOME/state/session-recovery/last-scan.json`, so a session that was skipped
says why (`healthy`, `outside the window`, `its agent is already working`, …).

## Install

From this repository checkout:

```sh
dsh plugin --profile <profile> add link:./packages/session-recovery
```

Or install the directory through the plugin manager. Restart the profile after
changing the plugin code.

## Configuration

All keys are optional; the defaults below are what the plugin uses when the row
carries no config.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set to `false` to keep the bundle installed but idle. |
| `scanDelaysMs` | `[4000, 15000, 30000, 60000]` | When to run a pass, in milliseconds after plugin load. A pass that cannot list sessions retries at the next entry. |
| `bootDelayMs` | `4000` | Shorthand for the first `scanDelaysMs` entry when `scanDelaysMs` is not set. |
| `maxSessions` | `3` | Maximum sessions resumed per pass. |
| `staggerMs` | `1500` | Pause between two resumed sessions. |
| `serviceTimeoutMs` | `60000` | How long one pass waits for the session controller, persistence and query services. |
| `maxAttempts` | `2` | Consecutive recovery prompts allowed for one session before it is left alone. |
| `recentWindowMinutes` | `720` | Only resume turns that ended within this window, so a months-old crash is not resurrected. |
| `includeUserAborted` | `true` | Also resume a session whose last turn you stopped with the Stop button. |
| `diagnostics` | `true` | Write `last-scan.json` with the decisions of the latest pass. |
| `diagnosticsDir` | `$DSH_HOME/state/session-recovery` | Where to write that report. |
| `prompt` | Chinese continuation text | Follow-up message template; `{reason}` is replaced with the detected interruption. |

Example row config:

```yaml
- id: session-recovery
  name: dsh-session-recovery
  config:
    maxSessions: 2
    includeUserAborted: false
    prompt: 'DSH restarted after {reason}. Continue the unfinished work, then summarize.'
```

## Permissions

The plugin keeps no state of its own beyond the diagnostics report. It uses these
host services:

- `sessions` — read live sessions, flush a resumed session.
- `sessionQuery` — list persisted sessions.
- `sessionPersistence` — read raw session logs (falls back to `sessionQuery`).
- `sessionController` — resume a session through its controller.
- `agents` — reach the resumed agent to queue the follow-up turn.

It writes only `last-scan.json` (disable it with `diagnostics: false`), never
creates, renames, or deletes sessions, never edits your files, and never calls a
tool on your behalf — it only asks the model to continue.

## Limitations

- Profiles without a session controller (some headless setups) cannot restore
  agents; the plugin logs a warning and does nothing.
- A session resumed this way starts a real model turn, so it consumes tokens and
  may block on an approval prompt the next time you open it.
- Sessions are considered once per process; a session that fails again later is
  picked up on the next restart, not while DSH keeps running.
- `includeUserAborted` resumes sessions you stopped on purpose. Turn it off if
  you use Stop as "this work is finished".
