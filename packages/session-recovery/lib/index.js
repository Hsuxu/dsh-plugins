/**
 * Host half of `dsh-session-recovery`.
 *
 * Once per DSH boot this plugin scans the persisted session logs, finds the
 * conversations whose last turn never finished, failed, or was stopped on
 * purpose, resumes them through the ordinary session controller, and queues a
 * follow-up turn so the model picks the work up where it stopped.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name, shown in logs and in the plugin inventory. */
export const name = 'dsh-session-recovery'

/** Services this plugin cannot work without. The rest are resolved lazily. */
export const inject = ['sessions']

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

/** When to try a pass, in milliseconds after boot. A failed pass retries later. */
const DEFAULT_SCAN_DELAYS = [4_000, 15_000, 30_000, 60_000]

/** How many per-session decisions the diagnostics file keeps. */
const DIAGNOSTIC_LIMIT = 40

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
    let timer

    const schedule = (index) => {
      const target = options.scanDelaysMs[index]
      if (target === undefined) return
      const previous = index === 0 ? 0 : options.scanDelaysMs[index - 1]
      timer = setTimeout(() => {
        scan(ctx, options, log, controller.signal)
          .then((completed) => {
            if (!completed && !controller.signal.aborted) schedule(index + 1)
          })
          .catch((error) => {
            if (controller.signal.aborted) return
            log.warn(`boot scan failed: ${describeError(error)}`)
            schedule(index + 1)
          })
      }, Math.max(0, target - previous))
    }

    schedule(0)

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

  const delays = Array.isArray(source.scanDelaysMs)
    ? source.scanDelaysMs.filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    : []
  const scanDelaysMs = (delays.length > 0 ? delays : [
    numberOf(source.bootDelayMs, DEFAULT_SCAN_DELAYS[0], 0, 600_000),
    ...DEFAULT_SCAN_DELAYS.slice(1),
  ])
    .map((value) => Math.min(Math.trunc(value), 600_000))
    .sort((left, right) => left - right)
    .filter((value, index, all) => index === 0 || value !== all[index - 1])

  return {
    enabled: source.enabled !== false,
    maxSessions: Math.trunc(numberOf(source.maxSessions, 3, 1, 20)),
    scanDelaysMs,
    staggerMs: numberOf(source.staggerMs, 1500, 0, 60_000),
    serviceTimeoutMs: numberOf(source.serviceTimeoutMs, 60_000, 1000, 300_000),
    maxAttempts: Math.trunc(numberOf(source.maxAttempts, 2, 1, 10)),
    recentWindowMinutes: numberOf(source.recentWindowMinutes, 720, 1, 43_200),
    includeUserAborted: source.includeUserAborted !== false,
    diagnostics: source.diagnostics !== false,
    diagnosticsDir:
      typeof source.diagnosticsDir === 'string' && source.diagnosticsDir.trim().length > 0
        ? source.diagnosticsDir
        : undefined,
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
 * Run one recovery pass for the current process.
 *
 * @param ctx - the plugin context.
 * @param options - normalized options.
 * @param log - logger facade.
 * @param signal - aborted when the plugin unloads.
 * @returns `true` when the pass ran to completion, `false` when it should retry.
 */
async function scan(ctx, options, log, signal) {
  const report = {
    generatedAt: new Date().toISOString(),
    scanDelaysMs: options.scanDelaysMs,
    includeUserAborted: options.includeUserAborted,
    recentWindowMinutes: options.recentWindowMinutes,
    recovered: [],
    decisions: [],
  }
  const note = (sessionId, decision, detail) => {
    if (report.decisions.length >= DIAGNOSTIC_LIMIT) return
    report.decisions.push({ sessionId, decision, detail })
  }
  const finish = (completed) => {
    writeDiagnostics(options, report, log)
    return completed
  }

  const controller = await waitFor(() => service(ctx, 'sessionController'), options.serviceTimeoutMs, signal)
  if (!controller) {
    log.warn('the session controller is unavailable in this profile; recovery skipped')
    return finish(false)
  }

  const persistence = await waitFor(() => service(ctx, 'sessionPersistence'), options.serviceTimeoutMs, signal)
  if (!persistence) {
    log.warn('session persistence is unavailable in this profile; recovery skipped')
    return finish(false)
  }

  const query = await waitFor(() => service(ctx, 'sessionQuery'), options.serviceTimeoutMs, signal)
  if (!query) {
    log.warn('the session query service is unavailable in this profile; recovery skipped')
    return finish(false)
  }

  let records
  try {
    records = await query.listSessions(signal)
  } catch (error) {
    log.warn(`cannot list sessions yet: ${describeError(error)}`)
    return finish(false)
  }

  const archived = archivedSessionIds(ctx)
  const cutoff = Date.now() - options.recentWindowMinutes * 60_000
  const sorted = [...records].sort((left, right) => createdAt(right) - createdAt(left))

  let recovered = 0
  let inspected = 0
  const budget = options.maxSessions * 4

  for (const record of sorted) {
    if (signal.aborted) break
    if (recovered >= options.maxSessions || inspected >= budget) break

    const header = record?.header
    if (!header || typeof header.id !== 'string' || header.id.length === 0) continue
    if (recoveredThisProcess.has(header.id)) continue
    if (header.origin === 'subagent') continue
    if (archived.has(header.id)) continue
    if (typeof header.cwd !== 'string' || header.cwd.length === 0) {
      note(header.id, 'skip', 'no working directory recorded')
      continue
    }
    if (!existsSync(header.cwd)) {
      note(header.id, 'skip', 'working directory no longer exists')
      continue
    }

    inspected += 1
    const live = record.live === true

    let verdict
    try {
      verdict = await classify(ctx, header.id, options, persistence, query, live)
    } catch (error) {
      note(header.id, 'skip', `cannot read its log (${describeError(error)})`)
      continue
    }
    if (!verdict) {
      note(header.id, 'skip', live ? 'nothing to continue' : 'last turn ended normally')
      continue
    }
    if (typeof verdict.at === 'number' && verdict.at < cutoff) {
      note(header.id, 'skip', `last turn ended ${describeAge(verdict.at)} ago, outside the window`)
      continue
    }

    const outcome = await recover(ctx, header.id, verdict, options, log)
    if (!outcome.ok) {
      note(header.id, 'skip', outcome.why)
      continue
    }

    recovered += 1
    recoveredThisProcess.add(header.id)
    report.recovered.push({ sessionId: header.id, reason: verdict.reason })
    note(header.id, 'recovered', verdict.reason)
    await sleep(options.staggerMs, signal)
  }

  if (recovered > 0) log.info(`recovered ${recovered} session(s) after restart`)
  else log.debug('no failed or interrupted session needed recovery')

  return finish(true)
}

/**
 * Decide whether one persisted session should be resumed.
 *
 * @param ctx - the plugin context.
 * @param sessionId - the session to classify.
 * @param options - normalized options.
 * @param persistence - the just-waited session persistence service.
 * @param query - the just-waited session query service.
 * @param live - whether the session already has an agent in this process.
 * @returns `{ reason, at }` when the session must be recovered, otherwise `undefined`.
 */
async function classify(ctx, sessionId, options, persistence, query, live) {
  const events = await readEvents(persistence, query, sessionId)
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
    // An open turn in a live agent is simply work in progress.
    if (live) return undefined
    return { reason: '进程异常退出，上一轮没有正常结束', at: eventTime(events[events.length - 1]) }
  }

  const endEvent = events[lastEnd]
  const reason = endEvent?.data?.reason
  const at = eventTime(endEvent)

  switch (reason?.kind) {
    case 'error': {
      const code = reason.error?.code
      if (typeof code === 'string' && NON_RECOVERABLE.test(code)) return undefined
      const detail = [reason.error?.code, reason.error?.message].filter(Boolean).join(': ')
      return { reason: detail.length > 0 ? `模型调用失败（${detail}）` : '模型调用失败', at }
    }
    case 'interrupted':
      return { reason: '上一轮被中断，没有正常结束', at }
    case 'aborted': {
      const cause = reason.reason?.kind ?? reason.cause?.kind
      if (cause === 'disposed') return { reason: 'DSH 退出时该轮仍在运行', at }
      if (options.includeUserAborted && (cause === 'user' || cause === 'legacy')) {
        return { reason: '上一轮被停止后没有继续', at }
      }
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * Read the raw event log of a session, live or cold.
 *
 * @param persistence - the session persistence service.
 * @param query - the session query service, used when persistence cannot read.
 * @param sessionId - the session to read.
 * @returns the persisted events in append order.
 */
async function readEvents(persistence, query, sessionId) {
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

  const snapshot = await query?.readSession?.(sessionId)
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
 * @returns `{ ok: true }` when a follow-up turn was queued, otherwise `{ ok: false, why }`.
 */
async function recover(ctx, sessionId, verdict, options, log) {
  let agent = ctx.agents?.get?.(sessionId)

  if (!agent) {
    const resolved = await ctx.get('sessionController').resolveAgent(sessionId)
    if (resolved?.error) return { ok: false, why: resolved.error.code ?? 'controller refused to resume' }
    agent = resolved?.agent ?? ctx.agents?.get?.(sessionId)
  }

  if (!agent || typeof agent.followup !== 'function') return { ok: false, why: 'no resumable agent' }
  if (agent.status === 'running') return { ok: false, why: 'its agent is already working' }

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
  return { ok: true }
}

/**
 * Persist the decisions of one pass, so an unexplained skip can be inspected.
 *
 * @param options - normalized options.
 * @param report - the pass report.
 * @param log - logger facade.
 */
function writeDiagnostics(options, report, log) {
  if (!options.diagnostics) return

  try {
    const dir = options.diagnosticsDir ?? join(dshHome(), 'state', 'session-recovery')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'last-scan.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch (error) {
    log.debug(`cannot write diagnostics: ${describeError(error)}`)
  }
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
 * Resolve the DeepSeek Harness home directory.
 *
 * @returns the directory holding profiles, sessions and state.
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
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
 * Timestamp of one persisted event.
 *
 * @param event - a session event.
 * @returns its timestamp in milliseconds, or `undefined`.
 */
function eventTime(event) {
  const value = event?.time
  return typeof value === 'number' ? value : undefined
}

/**
 * Render an age for a diagnostics line.
 *
 * @param timestamp - milliseconds since the epoch.
 * @returns a short human description.
 */
function describeAge(timestamp) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
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
