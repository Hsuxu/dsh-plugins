/**
 * Host half of `dsh-session-recovery`.
 *
 * Once per DSH boot this plugin scans the persisted session logs, finds the
 * conversations whose last turn never finished or failed, resumes them through
 * the ordinary session controller, and queues a follow-up turn so the model
 * picks the work up where it stopped.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

/** Cordis plugin name, shown in logs and in the plugin inventory. */
export const name = 'dsh-session-recovery'

/** Services this plugin cannot work without. The controller is resolved lazily. */
export const inject = ['sessions', 'sessionQuery']

/** Prefix that marks a message written by this plugin. */
const MARKER = '[session-recovery]'

/** Default follow-up text; `{reason}` is replaced with the classification. */
const DEFAULT_PROMPT = [
  'DSH 刚刚重启，上一轮对话因「{reason}」中断。',
  '请先确认还有哪些工作没有完成，然后从断点继续；',
  '如果这件事其实已经做完，用一两句话说明结果即可。',
].join('')

/** Failure codes that a restart cannot fix, so the session is left alone. */
const NON_RECOVERABLE = /auth|permission|invalid|bad.?request|content.?filter|quota|billing|unsupported|not.?found/i

/** Sessions recovered during this process, so a config reload cannot repeat it. */
const recoveredThisProcess = new Set()

/**
 * Register the one-shot boot scan.
 *
 * @param ctx - the plugin context.
 * @param config - the bundle row's config object (all keys optional).
 */
export function apply(ctx, config) {
  const options = normalizeOptions(config)
  const log = createLogger(ctx)

  if (!options.enabled) {
    log.debug('disabled by config, no session will be recovered')
    return
  }

  ctx.effect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      scan(ctx, options, log, controller.signal).catch((error) => {
        if (controller.signal.aborted) return
        log.warn(`boot scan failed: ${describeError(error)}`)
      })
    }, options.bootDelayMs)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, 'session-recovery: boot scan')
}

/**
 * Read and validate the config row, filling in safe defaults.
 *
 * @param config - the raw bundle config.
 * @returns normalized options.
 */
function normalizeOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {}

  const numberOf = (value, fallback, minimum, maximum) => {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(Math.max(value, minimum), maximum)
      : fallback
  }

  return {
    enabled: source.enabled !== false,
    maxSessions: Math.trunc(numberOf(source.maxSessions, 3, 1, 20)),
    bootDelayMs: numberOf(source.bootDelayMs, 4000, 0, 120_000),
    staggerMs: numberOf(source.staggerMs, 1500, 0, 60_000),
    serviceTimeoutMs: numberOf(source.serviceTimeoutMs, 60_000, 1000, 300_000),
    maxAttempts: Math.trunc(numberOf(source.maxAttempts, 2, 1, 10)),
    prompt:
      typeof source.prompt === 'string' && source.prompt.trim().length > 0
        ? source.prompt
        : DEFAULT_PROMPT,
  }
}

/**
 * Create a logger facade that never throws, even while the host is shutting down.
 *
 * @param ctx - the plugin context.
 * @returns level-tagged logging methods.
 */
function createLogger(ctx) {
  let logger
  try {
    logger = ctx.logger?.('session-recovery')
  } catch {
    logger = undefined
  }

  const write = (level) => (message) => {
    try {
      const sink = logger?.[level]
      if (typeof sink === 'function') {
        sink('%s', message)
        return
      }
      if (level === 'warn' || level === 'error') console.error(`[session-recovery] ${message}`)
      else console.log(`[session-recovery] ${message}`)
    } catch {
      // Logging must never take the scan down.
    }
  }

  return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') }
}

/**
 * Run the recovery pass for the current process.
 *
 * @param ctx - the plugin context.
 * @param options - normalized options.
 * @param log - logger facade.
 * @param signal - aborted when the plugin unloads.
 */
async function scan(ctx, options, log, signal) {
  const controller = await waitFor(() => service(ctx, 'sessionController'), options.serviceTimeoutMs, signal)
  if (!controller) {
    log.warn('the session controller is unavailable in this profile; recovery skipped')
    return
  }

  const persistence = await waitFor(() => service(ctx, 'sessionPersistence'), options.serviceTimeoutMs, signal)
  if (!persistence) {
    log.warn('session persistence is unavailable in this profile; recovery skipped')
    return
  }

  const records = await ctx.sessionQuery.listSessions(signal)
  const archived = archivedSessionIds(ctx)
  const candidates = []

  for (const record of records) {
    const header = record?.header
    if (!header || typeof header.id !== 'string' || header.id.length === 0) continue
    if (record.live) continue
    if (header.origin === 'subagent') continue
    if (archived.has(header.id)) continue
    if (typeof header.cwd !== 'string' || header.cwd.length === 0) continue
    if (!existsSync(header.cwd)) {
      log.debug(`skip ${header.id}: working directory no longer exists`)
      continue
    }
    candidates.push(record)
  }

  candidates.sort((left, right) => createdAt(right) - createdAt(left))

  let recovered = 0
  let inspected = 0
  const budget = options.maxSessions * 4

  for (const record of candidates) {
    if (signal.aborted) return
    if (recovered >= options.maxSessions || inspected >= budget) break

    const sessionId = record.header.id
    if (recoveredThisProcess.has(sessionId)) continue

    inspected += 1

    let verdict
    try {
      verdict = await classify(ctx, sessionId, options)
    } catch (error) {
      log.debug(`skip ${sessionId}: cannot read its log (${describeError(error)})`)
      continue
    }
    if (!verdict) continue

    try {
      if (await recover(ctx, sessionId, verdict, options, log)) {
        recovered += 1
        recoveredThisProcess.add(sessionId)
        await sleep(options.staggerMs, signal)
      }
    } catch (error) {
      log.warn(`cannot recover ${sessionId}: ${describeError(error)}`)
    }
  }

  if (recovered > 0) log.info(`recovered ${recovered} session(s) after restart`)
  else log.debug('no failed or interrupted session needed recovery')
}

/**
 * Decide whether one persisted session should be resumed.
 *
 * @param ctx - the plugin context.
 * @param sessionId - the session to classify.
 * @param options - normalized options.
 * @returns `{ reason }` when the session must be recovered, otherwise `undefined`.
 */
async function classify(ctx, sessionId, options) {
  const events = await readEvents(ctx, sessionId)
  if (!Array.isArray(events) || events.length === 0) return undefined

  let lastStart = -1
  let lastEnd = -1
  let humanMessages = 0
  let trailingRecoveries = 0
  let countingTrailing = true

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const type = event?.type

    if (type === 'turn/start' && lastStart < 0) lastStart = index
    if (type === 'turn/end' && lastEnd < 0) lastEnd = index

    if (type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue

    if (messageText(event.data).startsWith(MARKER)) {
      if (countingTrailing) trailingRecoveries += 1
    } else {
      humanMessages += 1
      countingTrailing = false
    }
  }

  // Never ran a turn, or nothing a person asked for: not our business.
  if (lastStart < 0 || humanMessages === 0) return undefined
  // A previous restart already asked for a continuation and it failed again.
  if (trailingRecoveries >= options.maxAttempts) return undefined

  if (lastEnd < lastStart) {
    return { reason: '进程异常退出，上一轮没有正常结束' }
  }

  const reason = events[lastEnd]?.data?.reason

  switch (reason?.kind) {
    case 'error': {
      const code = reason.error?.code
      if (typeof code === 'string' && NON_RECOVERABLE.test(code)) return undefined
      const detail = [reason.error?.code, reason.error?.message].filter(Boolean).join(': ')
      return { reason: detail.length > 0 ? `模型调用失败（${detail}）` : '模型调用失败' }
    }
    case 'interrupted':
      return { reason: '上一轮被中断，没有正常结束' }
    case 'aborted': {
      const cause = reason.reason?.kind ?? reason.cause?.kind
      if (cause === 'disposed') return { reason: 'DSH 退出时该轮仍在运行' }
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * Read the raw event log of a cold session.
 *
 * @param ctx - the plugin context.
 * @param sessionId - the session to read.
 * @returns the persisted events in append order.
 */
async function readEvents(ctx, sessionId) {
  const persistence = service(ctx, 'sessionPersistence')

  if (persistence && typeof persistence.open === 'function') {
    const handle = await persistence.open(sessionId, 'read')
    try {
      const result = await handle.read()
      return result?.events ?? []
    } finally {
      try {
        await handle.close?.()
      } catch {
        // Closing a read handle is best effort.
      }
    }
  }

  const snapshot = await ctx.sessionQuery.readSession(sessionId)
  return snapshot?.events ?? []
}

/**
 * Resume one session and ask the model to continue its work.
 *
 * @param ctx - the plugin context.
 * @param sessionId - the session to resume.
 * @param verdict - why the session needs recovery.
 * @param options - normalized options.
 * @param log - logger facade.
 * @returns whether a follow-up turn was queued.
 */
async function recover(ctx, sessionId, verdict, options, log) {
  if (typeof ctx.sessions.get === 'function' && ctx.sessions.get(sessionId)) {
    log.debug(`skip ${sessionId}: it is already live`)
    return false
  }

  const resolved = await ctx.get('sessionController').resolveAgent(sessionId)
  if (resolved?.error) {
    log.debug(`skip ${sessionId}: ${resolved.error.code ?? 'controller refused to resume'}`)
    return false
  }

  const agent = ctx.agents?.get?.(sessionId) ?? resolved?.agent
  if (!agent || typeof agent.followup !== 'function') {
    log.debug(`skip ${sessionId}: no resumable agent`)
    return false
  }
  if (agent.status === 'running') {
    log.debug(`skip ${sessionId}: its agent is already working`)
    return false
  }

  const message = {
    id: randomUUID(),
    content: [{ type: 'text', text: `${MARKER} ${renderPrompt(options.prompt, verdict.reason)}` }],
    source: { kind: 'user' },
  }

  // Deliver outside any initiator scope, exactly as scheduled messages are sent.
  const deliver = () => agent.followup(message)
  if (typeof ctx.agents?.withoutInitiator === 'function') ctx.agents.withoutInitiator(deliver)
  else deliver()

  await ctx.sessions.flush(agent.session)

  log.info(`recovered session ${sessionId}: ${verdict.reason}`)
  return true
}

/**
 * Fill the `{reason}` placeholder of the follow-up text.
 *
 * @param template - configured prompt.
 * @param reason - classification of the interrupted turn.
 * @returns the prompt to send.
 */
function renderPrompt(template, reason) {
  return template.replaceAll('{reason}', reason)
}

/**
 * Extract plain text from a message payload.
 *
 * @param message - a session `user/message` payload.
 * @returns the concatenated text blocks.
 */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text.trim()
}

/**
 * Read the ids the workspace registry has archived.
 *
 * @param ctx - the plugin context.
 * @returns a set of session ids.
 */
function archivedSessionIds(ctx) {
  let ids
  try {
    ids = service(ctx, 'workspaceRegistry')?.archivedSessionIds
  } catch {
    ids = undefined
  }
  if (ids instanceof Set) return ids
  if (Array.isArray(ids)) return new Set(ids)
  return new Set()
}

/**
 * Read a service without failing when this profile does not mount it.
 *
 * @param ctx - the plugin context.
 * @param serviceName - registry key.
 * @returns the service or `undefined`.
 */
function service(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/**
 * Poll until a service appears or the timeout elapses.
 *
 * @param read - reads the service.
 * @param timeoutMs - how long to wait.
 * @param signal - aborts the wait.
 * @returns the service or `undefined`.
 */
async function waitFor(read, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (signal.aborted) return undefined
    const value = read()
    if (value) return value
    if (Date.now() >= deadline) return undefined
    await sleep(250, signal)
  }
}

/**
 * Wait for a delay, returning early when the plugin unloads.
 *
 * @param ms - delay in milliseconds.
 * @param signal - aborts the wait.
 */
function sleep(ms, signal) {
  if (!(ms > 0) || signal.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener?.('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener?.('abort', done, { once: true })
  })
}

/**
 * Sort key for a session record.
 *
 * @param record - a session record from the query service.
 * @returns its creation timestamp.
 */
function createdAt(record) {
  const value = record?.header?.createdAt
  return typeof value === 'number' ? value : 0
}

/**
 * Render an error for a log line.
 *
 * @param error - anything thrown.
 * @returns a short description.
 */
function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
