import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { BACKENDS, COMMAND_SUPPORT, currentBackend, isAuthError, isMissingCommand, nativeCommands, printForce } from './backends.js'
import { firstListedModel } from './catalog.js'
import { ClaudeStream } from './claude-stream.js'
import { CodexStream } from './codex-stream.js'
import { AntigravityStream } from './antigravity-stream.js'
import { CodexAppClient } from './codex-app.js'
import { CodexPlanStream } from './codex-plan-stream.js'
import { backendOfProvider, providerId } from './models.js'
import { PLAN_EVENT, latestPlanEvent } from './plan.js'
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

/** Await `promise`, but run `onAbort` and reject as soon as `signal` aborts. */
function waitFor(promise, signal, onAbort) {
  if (!signal) return promise
  if (signal.aborted) {
    onAbort?.()
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      onAbort?.()
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
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
  const planAborts = new Map()
  const planSessions = new Map()

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

    if (backendId === 'codex') {
      ctx.commands.register({
        name: 'codex-plan',
        description: 'Plan with Codex Plan mode, then approve to implement',
        input: { hint: '<task> | approve | off' },
        handler: ({ agent, rawInput, signal }) =>
          handleCodexPlan({
            agent,
            rawInput,
            signal,
            record: (session, type, data) => record(session, type, data),
          }),
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

  async function closePlanSession(sessionId) {
    const state = planSessions.get(sessionId)
    if (!state) return
    planSessions.delete(sessionId)
    await state.client.close().catch(() => {})
  }

  /** One app-server turn in Plan collaboration mode, streamed into `writer`. */
  async function planTurn(agent, task, signal, record, writer) {
    const session = agent.session
    const cwd = session.header?.cwd ?? process.cwd()
    backend = currentBackend(backendId)
    const { model, effort } = selectedModel(agent)
    const runModel = String(model || backend.defaultModel || firstListedModel(backend.id) || backend.model || 'gpt-6.1-sol')
    let state = planSessions.get(session.id)
    if (!state || state.backendId !== backend.id) {
      const client = new CodexAppClient({
        backend,
        cwd,
        onNotification: () => {},
        name: 'dsh-cli-bridge',
        version: '0.1.0',
      })
      state = { client, backendId: backend.id, cwd, runModel, threadId: null }
      planSessions.set(session.id, state)
    }
    const client = state.client
    const stream = new CodexPlanStream({ onUpdate: (update) => writer.update(update) })
    client.onNotification = (method, params) => stream.push(method, params)
    try {
      if (state.threadId === null) {
        await client.start()
        const thread = await client.request('thread/start', {
          cwd,
          model: runModel,
          sandbox: 'read-only',
          approvalPolicy: 'never',
        }, 30_000)
        state.threadId = thread?.thread?.id ?? thread?.id
        if (typeof state.threadId !== 'string' || !state.threadId) throw new Error('Codex app-server returned no thread id')
      }
      const started = await client.request('turn/start', {
        threadId: state.threadId,
        input: [{ type: 'text', text: task }],
        collaborationMode: {
          mode: 'plan',
          settings: { model: runModel, reasoning_effort: effort ?? null, developer_instructions: null },
        },
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
      }, 30_000)
      const turnId = started?.turn?.id
      if (typeof turnId !== 'string' || !turnId) throw new Error('Codex app-server returned no turn id')
      await waitForPlan(stream, signal, () => {
        void client.request('turn/interrupt', { threadId: state.threadId, turnId }, 10_000).catch(() => {})
      })
      const failure = stream.failure()
      if (failure !== undefined) throw new Error(failure)
      const plan = stream.text()
      if (!plan) throw new Error('Codex plan turn completed without plan text')
      return { threadId: state.threadId, plan }
    } catch (error) {
      await closePlanSession(session.id)
      throw error
    }
  }

  /** Wait for a plan turn with an idle and total deadline. */
  async function waitForPlan(stream, signal, onAbort) {
    let totalTimer
    let idleTimer
    let rejectDeadline
    const deadline = new Promise((_, reject) => {
      rejectDeadline = reject
      totalTimer = setTimeout(() => reject(new Error('Codex plan timed out after 10 minutes')), 10 * 60 * 1000)
      idleTimer = setInterval(() => {
        if (Date.now() - stream.lastEventAt > 2 * 60 * 1000) reject(new Error('Codex plan stalled: no app-server event for 2 minutes'))
      }, 15 * 1000)
    })
    try {
      await waitFor(Promise.race([stream.done, deadline]), signal, onAbort)
    } finally {
      clearTimeout(totalTimer)
      clearInterval(idleTimer)
      rejectDeadline?.(new Error('plan settled'))
    }
  }

  /** Native DSH plan-review popup. Approve and Keep planning use the same labels as dsh-plan-mode. */
  async function reviewPlan(agent, plan, signal) {
    const interaction = ctx.get('userQuestions')
    if (interaction === undefined) throw new Error('no user-questions channel is available to review the Codex plan')
    try {
      const answer = await interaction.ask({
        agent,
        signal,
        questions: [{
          id: 'plan-review',
          header: 'Plan review',
          question: 'Approve this plan and leave plan mode?',
          detail: plan,
          options: [
            { label: 'Approve', description: 'Leave plan mode; implement the plan from the next step.' },
            { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to Codex.' },
          ],
          intent: { kind: 'plan-review', approve: 'Approve' },
        }],
      })
      const item = answer.answers.find((entry) => entry.id === 'plan-review')
      const approved = item?.selected?.length === 1 && item.selected[0] === 'Approve' && item.custom === undefined
      return { approved, feedback: approved ? '' : String(item?.custom ?? '') }
    } catch (error) {
      if (error?.code === 'ASK_CANCELLED' || signal.aborted) return { dismissed: true }
      throw error
    }
  }

  /** `/codex-plan <task>` starts a real turn; the pre-step below streams and reviews the plan. */
  async function handleCodexPlan({ agent, rawInput, signal, record }) {
    const session = agent.session
    const task = String(rawInput ?? '').trim()
    const state = latestPlanEvent(session)
    if (!task) return { kind: 'error', text: 'Usage: /codex-plan <task> | /codex-plan approve | /codex-plan off' }
    if (task === 'off') {
      planAborts.get(session.id)?.abort()
      planAborts.delete(session.id)
      await closePlanSession(session.id)
      record(session, PLAN_EVENT, {
        active: false,
        pending: false,
        reviewPending: false,
        threadId: state?.threadId ?? null,
        plan: '',
        requestId: state?.requestId ?? null,
        updatedAt: Date.now(),
      })
      return { kind: 'success', text: 'Exited Codex Plan mode.' }
    }
    if (task === 'approve') {
      if (!state?.reviewPending || typeof state.plan !== 'string' || !state.plan.trim()) {
        return { kind: 'error', text: 'No plan is waiting for approval.' }
      }
      const plan = state.plan
      record(session, PLAN_EVENT, {
        active: false,
        pending: false,
        reviewPending: false,
        threadId: state.threadId ?? null,
        plan,
        requestId: state.requestId ?? null,
        approved: true,
        updatedAt: Date.now(),
      })
      agent.followup({
        content: [{ type: 'text', text: `The plan is approved. Implement it now, following it exactly:\n\n${plan}` }],
        source: { kind: 'user' },
      })
      await closePlanSession(session.id)
      return { kind: 'success', text: 'Plan approved. Implementing it now.' }
    }
    if (state?.pending) return { kind: 'error', text: 'Codex is already planning; wait for the plan or /codex-plan off.' }
    if (state?.reviewPending) return { kind: 'error', text: 'A plan is already waiting; use /codex-plan approve or /codex-plan off.' }
    const requestId = randomUUID()
    const controller = new AbortController()
    planAborts.set(session.id, controller)
    record(session, PLAN_EVENT, {
      active: true,
      pending: true,
      reviewPending: false,
      threadId: null,
      plan: '',
      requestId,
      updatedAt: Date.now(),
    })
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: task }],
      source: { kind: 'user' },
    }))
    return { kind: 'success', text: 'Codex plan started; the plan will stream into this conversation.' }
  }

  /** Stream one or more plan attempts, then ask the native DSH review. */
  async function runPlanFlow(agent, messages, turn, signal, record) {
    let current = messages
    let step = 0
    let task = messages.map((message) => (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')).join('\n\n').trim()
    for (;;) {
      signal.throwIfAborted()
      const session = agent.session
      backend = currentBackend(backendId)
      const { model, effort } = selectedModel(agent)
      const runModel = String(model || backend.defaultModel || firstListedModel(backend.id) || backend.model || 'gpt-6.1-sol')
      const writer = new TurnWriter({ session, turn, step, provider: providerId(backend.id), model: runModel, cwd: session.header?.cwd, pace: true, live: liveStream(ctx, agent) })
      writer.admit(current)
      let result
      try {
        result = await planTurn(agent, task, signal, record, writer)
      } finally {
        await writer.drain().catch(() => {})
        writer.finish()
        step = writer.step
      }
      const plan = result.plan
      record(session, PLAN_EVENT, {
        active: true,
        pending: false,
        reviewPending: true,
        threadId: result.threadId,
        plan,
        requestId: latestPlanEvent(session)?.requestId ?? null,
        updatedAt: Date.now(),
      })
      const review = await reviewPlan(agent, plan, signal)
      if (review.dismissed) {
        planAborts.delete(session.id)
        await closePlanSession(session.id)
        return
      }
      if (review.approved) {
        planAborts.delete(session.id)
        record(session, PLAN_EVENT, {
          active: false,
          pending: false,
          reviewPending: false,
          threadId: result.threadId,
          plan,
          requestId: latestPlanEvent(session)?.requestId ?? null,
          approved: true,
          updatedAt: Date.now(),
        })
        agent.followup({
          content: [{ type: 'text', text: `The plan is approved. Implement it now, following it exactly:\n\n${plan}` }],
          source: { kind: 'user' },
        })
        await closePlanSession(session.id)
        return
      }
      task = review.feedback.trim() || 'Revise the plan based on the review; present the updated plan.'
      current = [createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } })]
      record(session, PLAN_EVENT, {
        active: true,
        pending: true,
        reviewPending: false,
        threadId: result.threadId,
        plan: '',
        requestId: latestPlanEvent(session)?.requestId ?? null,
        updatedAt: Date.now(),
      })
    }
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
      const argv = backend.printArgv({ model, effort, cwd, resume, force: printForce(backend), prompt: text, addDirs: files.length ? [tmpdir()] : [] })
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
    const planState = latestPlanEvent(session)
    if (backendId === 'codex' && planState?.active && !planState.reviewPending) {
      const interrupt = new AbortController()
      active.set(agent, interrupt)
      const planAbort = planAborts.get(session.id)?.signal
      const signal = planAbort
        ? AbortSignal.any([turnSignal, interrupt.signal, lifetime.signal, planAbort])
        : AbortSignal.any([turnSignal, interrupt.signal, lifetime.signal])
      try {
        await runPlanFlow(agent, messages, turn, signal, record)
      } catch (error) {
        if (!signal.aborted) {
          const message = error instanceof Error ? error.message : String(error)
          record(session, PLAN_EVENT, {
            active: false,
            pending: false,
            reviewPending: false,
            threadId: planState.threadId ?? null,
            plan: planState.plan ?? '',
            requestId: planState.requestId ?? null,
            updatedAt: Date.now(),
            error: message,
          })
          record(session, RECORD_TRACE, { backend: 'codex', model: null, error: message })
          planAborts.delete(session.id)
          await closePlanSession(session.id)
          throw turnError(error, currentBackend('codex'))
        }
      } finally {
        active.delete(agent)
        completed.set(agent, turnSignal)
      }
      return admitted
    }
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
    for (const controller of planAborts.values()) controller.abort()
    planAborts.clear()
    for (const id of [...planSessions.keys()]) await closePlanSession(id)
    lifetime.abort()
  }, 'dsh-cli-bridge: stop external processes')
}
