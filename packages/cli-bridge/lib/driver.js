import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { BACKENDS, COMMAND_SUPPORT, currentBackend, isAuthError, isMissingCommand, nativeCommands, printForce } from './backends.js'
import { firstListedModel } from './catalog.js'
import { ClaudeStream } from './claude-stream.js'
import { CodexStream } from './codex-stream.js'
import { AntigravityStream } from './antigravity-stream.js'
import { backendOfProvider, providerId } from './models.js'
import { QUOTA_SUPPORT, queryQuota } from './quota.js'
import { BINDING_EVENT, cleanResumeTitle, clearResumeResultText, isClearResumeToken, isSessionId, listBackendSessions, readBinding, resumeResultText } from './sessions.js'
import { registerCliSkills, withSkillMessages } from './skills.js'
import { TurnWriter, redact } from './turn-writer.js'
import { spawnAgent, stopAgent } from './process.js'

/**
 * Agent-scoped driver mounted by a cli Agent preset. It answers every proposed
 * step of its Agent by running the turn in an external agent CLI, writes the
 * resulting steps into the Session, and admits no messages to the model loop, so
 * the DSH model is never called. The DSH composer, stop button, queue and
 * transcript keep working unchanged.
 */
export const name = 'dsh-cli-bridge-driver'
export const inject = ['commands', 'skills']

const RECORD_PERMISSION = 'plugin:dsh-cli-bridge/permission'
const RECORD_STREAM = 'plugin:dsh-cli-bridge/stream'
const RECORD_TRACE = 'plugin:dsh-cli-bridge/trace'
const KILL_GRACE_MS = 3000
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

let appendPluginRecord
try {
  ;({ appendPluginRecord } = await import('@deepseek-ai/dsh-session'))
} catch {
  appendPluginRecord = undefined
}

/** The model picker records its choice as `model/selection`; `agent.options` keeps the creation-time route. */
function latestSelection(session) {
  let selection
  for (const event of session.snapshotEvents()) if (event.type === 'model/selection') selection = event.data
  return selection
}

/** The loop records only the message of a non-LLM error, so the message carries the remedy. */
function turnError(error, backend) {
  if (isAuthError(error)) return new Error(`${backend.label} is not signed in: run \`${backend.login}\` in a terminal on the DSH machine, then send again`)
  if (isMissingCommand(error)) return new Error(`${backend.label} could not start: command not found: ${backend.argv[0]} (install it and make sure it is on PATH for the DSH process)`)
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * A stream-json user message, as `--input-format stream-json` reads it on stdin;
 * images travel inline as Anthropic image blocks.
 */
function userEnvelope(messages) {
  const content = []
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text })
      else if (part.type === 'image' && typeof part.data === 'string') {
        content.push({ type: 'image', source: { type: 'base64', media_type: part.mimeType ?? part.mediaType ?? 'image/png', data: part.data } })
      }
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}

const STREAMS = { claude: ClaudeStream, codex: CodexStream, antigravity: AntigravityStream }

/**
 * Plain-text prompt for print modes that read text, so images travel as files the agent can open.
 * @returns the prompt text and the files to delete after the turn.
 */
async function printPrompt(messages) {
  const parts = []
  const files = []
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type === 'text') parts.push(part.text)
      else if (part.type === 'image' && typeof part.data === 'string') {
        const mime = part.mimeType ?? part.mediaType
        const file = join(tmpdir(), `dsh-cli-${randomUUID()}.${IMAGE_EXT[mime] ?? 'png'}`)
        await writeFile(file, Buffer.from(part.data, 'base64'))
        files.push(file)
        parts.push(`[Attached image: ${file}]`)
      }
    }
  }
  return { text: parts.join('\n\n'), files }
}

/**
 * Run one print-mode turn and feed its transcript to `onEvent`.
 * @returns the exit code, stderr tail, and whether any transcript line arrived.
 */
function runPrint({ argv, cwd, env, stdin, signal, onEvent }) {
  if (signal.aborted) return Promise.resolve({ code: null, stderr: '', heard: false })
  return new Promise((resolve, reject) => {
    const child = spawnAgent(argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env })
    let stderr = ''
    let heard = false
    let stopped
    const onAbort = () => {
      stopped ??= stopAgent(child, KILL_GRACE_MS)
      stopped.catch(reject)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (!line.trim()) return
      let event
      try {
        event = JSON.parse(line)
      } catch {
        stderr = (stderr + line + '\n').slice(-8192)
        return
      }
      heard = true
      onEvent(event)
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      Promise.resolve(stopped).then(() => resolve({ code, stderr: stderr.trim(), heard }), reject)
    })
  })
}

/**
 * Bind this DSH session to an existing CLI session. Print backends store
 * `chatId` (passed as `--resume` / `--conversation`); the transcript itself
 * stays in the CLI.
 */
export async function handleResume({ session, backend, rawInput, record, close, lookup }) {
  const id = String(rawInput ?? '').trim()
  const binding = readBinding(session)
  const boundId = binding?.backend === backend.id ? binding.chatId : undefined
  if (!id) {
    return {
      kind: 'success',
      text: boundId ? `This session is bound to ${boundId}. Pick another from /resume, or pass a session id.` : 'Pick a session from /resume, or pass a session id.',
    }
  }
  const cwd = session.header?.cwd
  if (isClearResumeToken(id)) {
    record(BINDING_EVENT, { backend: backend.id, cwd, cleared: true })
    close?.()
    return { kind: 'success', text: clearResumeResultText(boundId ?? binding?.chatId) }
  }
  if (!isSessionId(id)) return { kind: 'error', text: `Not a session id: ${id}` }
  const data = { backend: backend.id, cwd, chatId: id, resumed: true }
  record(BINDING_EVENT, data)
  close?.()
  let title
  try {
    const rows = await (lookup ?? listBackendSessions)(backend.id, cwd ?? process.cwd())
    title = cleanResumeTitle(rows.find((row) => row.id === id)?.title)
    if (title) {
      record(BINDING_EVENT, { ...data, title })
      if (loggedTitle(session) !== title) {
        session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
      }
    }
  } catch {
    title = undefined
  }
  return { kind: 'success', text: resumeResultText(title, id) }
}

function loggedTitle(session) {
  let title = ''
  for (const event of session.snapshotEvents?.() ?? []) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  return title.trim()
}

/** Frame counters of `agent/assistant-stream`, monotone for one attached Agent. */
const liveCounters = new WeakMap()

function liveStream(ctx, agent) {
  let counters = liveCounters.get(agent)
  if (!counters) liveCounters.set(agent, (counters = { revision: 0, attempt: 0 }))
  const events = agentEvents(ctx, agent)
  return {
    emit: (frame) => events.emit('agent/assistant-stream', { frame }),
    nextRevision: () => ++counters.revision,
    nextAttemptId: () => `${agent.session.id}:cli-${++counters.attempt}`,
  }
}

export function apply(ctx, config = {}) {
  const backendId = BACKENDS[config.backend] ? config.backend : 'claude-code'
  let backend = currentBackend(backendId)
  const lifetime = new AbortController()
  const active = new WeakMap()
  const completed = new WeakMap()

  // The loop treats our empty admission as a completed turn and retires its
  // driver before checking the inbox. Wake the existing input after that boundary.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const signal = completed.get(agent)
    completed.delete(agent)
    if (!signal || signal.aborted || lifetime.signal.aborted) return
    const target = agent.inbox.nextStep.length ? 'next-step' : 'next-turn'
    const pending = target === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn
    const message = pending.at(-1)
    if (!message) return
    // Transfer the same identity to send(), which can wake an idle driver. This
    // is not a discard: attachments and the original source still belong to it.
    agent.session.append('agent/inbox/spliced', { target, start: pending.length - 1, removedCount: 1, inserted: [] })
    agent.send(message, target, true)
  })

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent.inbox.nextStep.some((pending) => pending.id === message.id)) active.get(agent)?.abort()
  })

  const record = (session, type, data) => {
    if (!appendPluginRecord) return
    try {
      appendPluginRecord(session, type, JSON.parse(JSON.stringify(redact(data))))
    } catch (error) {
      console.warn('[dsh-cli-bridge]', error)
    }
  }

  registerCliSkills(ctx)
  if (typeof ctx.commands?.register === 'function') {
    ctx.commands.register({
      name: 'resume',
      description: 'Resume an existing CLI session',
      input: { hint: '<session-id>' },
      handler: ({ agent, rawInput }) =>
        handleResume({
          session: agent.session,
          backend,
          rawInput,
          record: (type, data) => record(agent.session, type, data),
        }),
    })

    const forward = (agent, line) => {
      agent.followup({ content: [{ type: 'text', text: line }], source: { kind: 'user' } })
      return { kind: 'success', text: `Sent \`${line.split(/\s/)[0]}\` to ${backend.label}.` }
    }

    // The CLI's own print mode expands these; forwarding the raw line keeps its
    // grammar, including arguments and multiline input.
    for (const command of nativeCommands(backendId)) {
      ctx.commands.register({
        name: command,
        description: `Run ${backend.label}'s /${command}`,
        input: { hint: '[arguments]' },
        handler: ({ agent, rawInput }) => forward(agent, rawInput ? `/${command} ${rawInput}` : `/${command}`),
      })
    }

    // DSH's own /compact stays global. This explicit name asks the CLI to
    // compact its own context, which is a different store from DSH's log.
    if (COMMAND_SUPPORT[backendId]?.compact) {
      ctx.commands.register({
        name: 'cli-compact',
        description: `Ask ${backend.label} to compact its own context (DSH /compact only compacts the DSH log)`,
        input: { hint: '[instructions]' },
        handler: ({ agent, rawInput }) => forward(agent, rawInput ? `/compact ${rawInput}` : '/compact'),
      })
    }

    if (QUOTA_SUPPORT[backendId]) {
      ctx.commands.register({
        name: 'quota',
        description: `Show ${backend.label} subscription quota`,
        handler: async () => {
          const result = await queryQuota(backendId)
          return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.error }
        },
      })
    }

    // Any other command line reaches the CLI verbatim, so a command this plugin
    // does not know is still handled by the agent that owns it.
    ctx.commands.register({
      name: 'agent',
      description: `Send a raw line to ${backend.label}`,
      input: { hint: '<command or prompt>' },
      handler: ({ agent, rawInput }) => {
        const line = String(rawInput ?? '').trim()
        if (!line) return { kind: 'error', text: 'Usage: /agent <command or prompt>' }
        return forward(agent, line)
      },
    })
  }

  /** Model and reasoning effort the user picked for this session, if they belong to this backend's catalog route. */
  function selectedModel(agent) {
    const { provider, model, reasoningEffort } = latestSelection(agent.session) ?? agent.options ?? {}
    const picked = backendOfProvider(provider)
    // A variant id such as `grok-4.7[fast=true]` is not a `--model` id.
    if (picked === backend.id) return { model: model?.includes('[') ? backend.model : model, effort: reasoningEffort || undefined }
    if (picked !== undefined && BACKENDS[picked]) {
      throw new Error(`this session runs ${backend.label}, but the selected model belongs to ${BACKENDS[picked].label}; pick a ${backend.label} model or start a ${BACKENDS[picked].label} session`)
    }
    return { model: backend.model }
  }

  /** One print-mode process per turn, resuming the bound chat. */
  async function printTurn(session, writer, { model, effort }, messages, signal) {
    const cwd = session.header?.cwd ?? process.cwd()
    const binding = readBinding(session)
    const resume = binding?.backend === backend.id ? binding.chatId : undefined
    const { text, files } = backend.stdin === 'json' ? { text: '', files: [] } : await printPrompt(messages)
    try {
      const onUpdate = (update) => writer.update(update)
      const stream = new STREAMS[backend.dialect](onUpdate, { inputIncludesCache: backend.inputIncludesCache })
      const argv = backend.printArgv({ model, effort, cwd, resume, force: printForce(backend), prompt: text })
      const outcome = await runPrint({
        argv,
        cwd,
        env: backend.printEnv({ ...process.env, NO_COLOR: '1' }),
        stdin: backend.stdin === 'json' ? userEnvelope(messages) : '',
        signal,
        onEvent: (event) => {
          if (stream.recordable(event)) record(session, RECORD_STREAM, event)
          stream.push(event)
        },
      })
      if (stream.sessionId && stream.sessionId !== resume) record(session, BINDING_EVENT, { backend: backend.id, cwd, chatId: stream.sessionId })
      writer.usage = stream.usage()
      if (signal.aborted) return
      const failure = stream.failure() ?? (outcome.code !== 0 && !stream.result ? outcome.stderr || `${argv[0]} exited with code ${outcome.code}` : undefined)
      if (failure !== undefined) {
        record(session, RECORD_TRACE, {
          backend: backend.id,
          argv,
          model: model ?? null,
          effort: effort ?? null,
          resume: resume ?? null,
          exitCode: outcome.code,
          stderr: outcome.stderr ? outcome.stderr.slice(-4000) : '',
          error: failure,
        })
        throw new Error(failure)
      }
    } finally {
      await Promise.all(files.map((file) => rm(file, { force: true })))
    }
  }

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal: turnSignal }) => {
    const admitted = { kind: 'enter', messages: [] }
    completed.delete(agent)
    if (messages.length === 0) {
      completed.set(agent, turnSignal)
      return admitted
    }
    const session = agent.session
    let step = 0
    try {
      do {
        turnSignal.throwIfAborted()
        const interrupt = new AbortController()
        active.set(agent, interrupt)
        if (agent.inbox.nextStep.length) interrupt.abort()
        const signal = AbortSignal.any([turnSignal, interrupt.signal, lifetime.signal])
        backend = currentBackend(backendId)
        const writer = new TurnWriter({ session, turn, step, provider: providerId(backend.id), model: 'default', cwd: session.header?.cwd, pace: true, live: liveStream(ctx, agent) })
        try {
          writer.admit(messages)
          const prompted = await withSkillMessages(ctx.skills, messages, { cwd: session.header?.cwd ?? process.cwd(), scope: agent, signal })
          signal.throwIfAborted()
          const { model, effort } = selectedModel(agent)
          const runModel = model ?? backend.defaultModel ?? firstListedModel(backend.id)
          writer.model = runModel ?? 'default'
          await printTurn(session, writer, { model: runModel, effort }, prompted, signal)
        } catch (error) {
          if (!signal.aborted) throw turnError(error, backend)
        } finally {
          const onAbort = () => writer.flushPaced()
          signal.addEventListener('abort', onAbort, { once: true })
          try {
            if (!signal.aborted) await writer.drain()
          } finally {
            signal.removeEventListener('abort', onAbort)
            writer.finish()
            step = writer.step
          }
        }
        turnSignal.throwIfAborted()
        lifetime.signal.throwIfAborted()
        // Claim steering inside this turn, before any ordinary queued follow-up.
        // Record consumption rather than Inbox.remove()'s discard semantics.
        messages = [...agent.inbox.nextStep]
        if (messages.length) {
          session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: messages.length, inserted: [] })
          const events = agentEvents(ctx, agent)
          for (const message of messages) events.emit('agent/inbox/claimed', { message, turn })
        }
      } while (messages.length)
      completed.set(agent, turnSignal)
      return admitted
    } finally {
      active.delete(agent)
    }
  })

  ctx.effect(() => async () => {
    lifetime.abort()
  }, 'dsh-cli-bridge: stop external processes')
}
