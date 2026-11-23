# dsh-session-recovery

A system-maintenance plugin for DeepSeek Harness. After DSH starts, it looks for
conversations whose last turn never finished — a crash, a forced exit, or a
model call that failed — and resumes them so the work continues without you
reopening every session by hand.

## What it does

Once per boot, after a short delay:

1. Lists every persisted session and skips the ones that are already live,
   belong to a subagent, were archived, or whose working directory is gone.
2. Reads the tail of each remaining log and classifies the last turn:
   - no `turn/end` after its `turn/start`, or the turn ended as `interrupted` —
     the process died mid-turn;
   - the turn ended with `error` from the model provider;
   - the turn was aborted with the `disposed` cause — DSH quit while it ran.
   A turn you stopped yourself, a turn that completed, and a turn cut off by
   `max-tokens` are left alone.
3. Resumes the session through the ordinary session controller, so its agent
   preset, model selection, and working directory are restored exactly as the
   Web app would restore them.
4. Queues one follow-up user message that names the interruption and asks the
   model to continue from where it stopped. The message is prefixed with
   `[session-recovery]` so later rescans can recognize it.

Sessions that keep failing are retried at most `maxAttempts` times across
restarts, and only the `maxSessions` most recently created candidates are
touched in one boot.

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
| `bootDelayMs` | `4000` | Delay after plugin load before scanning, so persistence and the session controller are ready. |
| `maxSessions` | `3` | Maximum sessions resumed per boot. |
| `staggerMs` | `1500` | Pause between two resumed sessions. |
| `serviceTimeoutMs` | `60000` | How long to wait for the session controller to appear. |
| `maxAttempts` | `2` | Consecutive recovery prompts allowed for one session before it is left alone. |
| `prompt` | Chinese continuation text | Follow-up message template; `{reason}` is replaced with the detected interruption. |

Example row config:

```yaml
- id: session-recovery
  name: dsh-session-recovery
  config:
    maxSessions: 2
    prompt: 'DSH restarted after {reason}. Continue the unfinished work, then summarize.'
```

## Permissions

The plugin needs no filesystem writes of its own. It uses these host services:

- `sessions` — read live sessions, flush a resumed session.
- `sessionQuery` — list persisted sessions.
- `sessionPersistence` — read raw session logs (falls back to `sessionQuery`).
- `sessionController` — resume a session through its controller.
- `agents` — reach the resumed agent to queue the follow-up turn.

It never creates, renames, or deletes sessions, never edits your files, and
never calls a tool on your behalf — it only asks the model to continue.

## Limitations

- Profiles without a session controller (some headless setups) cannot restore
  agents; the plugin logs a warning and does nothing.
- A session resumed this way starts a real model turn, so it consumes tokens
  and may block on an approval prompt the next time you open it.
- The scan runs once per process; a session that fails again later is picked up
  on the next restart.
