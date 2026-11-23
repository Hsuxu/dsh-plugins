/** Boot-scan behaviour of the host half, exercised with a fake Cordis context. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../lib/index.js'

const cwd = process.cwd()
const now = Date.now()
const MARKER = '[session-recovery]'

const userMessage = (text, kind = 'user') => ({
  type: 'user/message',
  time: now,
  data: { id: `m-${text}`, content: [{ type: 'text', text }], source: { kind } },
})

const turn = (reason, time = now) => [
  { type: 'turn/start', time, data: { turn: 1 } },
  { type: 'turn/end', time, data: { turn: 1, reason } },
]

/** Last turns of every interesting session shape. */
const shapes = {
  completed: [userMessage('do it'), ...turn({ kind: 'completed' })],
  failed: [userMessage('do it'), ...turn({ kind: 'error', error: { code: 'SERVER', message: 'boom' } })],
  interrupted: [userMessage('do it'), ...turn({ kind: 'interrupted' })],
  crashed: [userMessage('do it'), { type: 'turn/start', time: now, data: { turn: 1 } }],
  stopped: [userMessage('do it'), ...turn({ kind: 'aborted', reason: { kind: 'user' } })],
  disposed: [userMessage('do it'), ...turn({ kind: 'aborted', reason: { kind: 'disposed' } })],
  unauthorized: [userMessage('do it'), ...turn({ kind: 'error', error: { code: 'AUTH', message: 'no key' } })],
  exhausted: [
    userMessage('do it'),
    ...turn({ kind: 'error', error: { code: 'TIMEOUT', message: 'slow' } }),
    userMessage(`${MARKER} continuing`),
    ...turn({ kind: 'error', error: { code: 'TIMEOUT', message: 'slow' } }),
    userMessage(`${MARKER} continuing`),
    ...turn({ kind: 'error', error: { code: 'TIMEOUT', message: 'slow' } }),
  ],
  empty: [],
  live: [userMessage('do it'), ...turn({ kind: 'error', error: { code: 'SERVER' } })],
  liveIdle: [userMessage('do it'), ...turn({ kind: 'aborted', reason: { kind: 'disposed' } })],
  retired: [
    userMessage('do it'),
    ...turn({ kind: 'aborted', reason: { kind: 'disposed' } }, now - 3 * 24 * 60 * 60 * 1000),
  ],
  subagent: [userMessage('do it'), ...turn({ kind: 'error', error: { code: 'SERVER' } })],
}

/** Sessions whose agent already exists in this process, and how busy it is. */
const existing = { live: 'running', liveIdle: 'idle' }

/**
 * Build one isolated set of session ids with their persisted logs.
 *
 * @returns ids prefixed so that several tests never collide inside the shared
 *   `recoveredThisProcess` bookkeeping of the plugin module.
 */
function createFixture() {
  const prefix = `t${Math.random().toString(16).slice(2, 8)}-`
  const logs = {}
  const records = []

  for (const [name, events] of Object.entries(shapes)) {
    const id = `${prefix}${name}`
    logs[id] = events
    records.push({
      header: {
        id,
        createdAt: 1000 - records.length,
        cwd: name === 'empty' ? undefined : cwd,
        origin: name === 'subagent' ? 'subagent' : undefined,
      },
      live: name in existing,
    })
  }

  return { logs, records }
}

/**
 * Build a fake host context around one fixture.
 *
 * @param fixture - the ids and logs to serve.
 * @param options - `persistence` toggles the persistence service;
 *   `failFirstList` makes the first `listSessions` call reject.
 * @returns the context, the log lines, and every queued follow-up.
 */
function createContext(fixture, { persistence = true, failFirstList = false } = {}) {
  const sent = []
  const lines = []
  const agents = {}
  const nameOf = (sessionId) => sessionId.slice(sessionId.indexOf('-') + 1)

  for (const record of fixture.records) {
    const id = record.header.id
    agents[id] = {
      status: existing[nameOf(id)] ?? 'idle',
      session: { id },
      followup(message) {
        sent.push({ sessionId: id, text: message.content[0].text, source: message.source.kind })
      },
    }
  }

  let listCalls = 0
  const services = {
    sessionController: {
      async resolveAgent(sessionId) {
        return agents[sessionId] ? { agent: agents[sessionId] } : { error: { code: 'session/not-found' } }
      },
    },
    sessionQuery: {
      async listSessions() {
        listCalls += 1
        if (failFirstList && listCalls === 1) throw new Error('storage is not ready')
        return fixture.records
      },
      readSession: async (sessionId) => ({ events: fixture.logs[sessionId] ?? [] }),
    },
  }

  if (persistence) {
    services.sessionPersistence = {
      async open(sessionId) {
        return {
          read: async () => ({ events: fixture.logs[sessionId] ?? [] }),
          close: async () => {},
        }
      },
    }
  }

  return {
    sent,
    lines,
    nameOf,
    ctx: {
      effect(effect) {
        return effect()
      },
      logger: () => ({
        info: (format, message) => lines.push(`info ${message ?? format}`),
        warn: (format, message) => lines.push(`warn ${message ?? format}`),
        debug: () => {},
        error: () => {},
      }),
      get: (name) => services[name],
      sessions: {
        get: () => undefined,
        flush: async () => true,
      },
      sessionQuery: {
        listSessions: async () => fixture.records,
        readSession: async (sessionId) => ({ events: fixture.logs[sessionId] ?? [] }),
      },
      agents: {
        get: (sessionId) => agents[sessionId],
      },
    },
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a disabled plugin never queues work', async () => {
  const { ctx, sent } = createContext(createFixture())

  apply(ctx, { enabled: false, scanDelaysMs: [0] })
  await wait(120)

  assert.equal(sent.length, 0)
})

test('recovers failed, interrupted, crashed and stopped sessions only once', async () => {
  const { ctx, sent, lines, nameOf } = createContext(createFixture())

  apply(ctx, { scanDelaysMs: [0], staggerMs: 0, maxSessions: 10, diagnostics: false })
  await wait(300)

  assert.deepEqual(sent.map((entry) => nameOf(entry.sessionId)).sort(), [
    'crashed',
    'disposed',
    'failed',
    'interrupted',
    'liveIdle',
    'stopped',
  ])

  for (const entry of sent) {
    assert.equal(entry.source, 'user')
    assert.ok(entry.text.startsWith(MARKER))
    assert.equal(entry.text.includes('{reason}'), false)
  }

  assert.ok(lines.some((line) => line.startsWith('info recovered 6 session(s)')))
})

test('a failed pass retries at the next scan window', async () => {
  const { ctx, sent } = createContext(createFixture(), { failFirstList: true })

  apply(ctx, { scanDelaysMs: [0, 150], staggerMs: 0, maxSessions: 2, diagnostics: false })
  await wait(80)
  assert.equal(sent.length, 0)

  await wait(400)
  assert.ok(sent.length > 0)
})

test('writes a diagnostics report of every decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-recovery-'))
  const { ctx, nameOf } = createContext(createFixture())

  apply(ctx, { scanDelaysMs: [0], staggerMs: 0, maxSessions: 10, diagnosticsDir: dir })
  await wait(300)

  const report = JSON.parse(readFileSync(join(dir, 'last-scan.json'), 'utf8'))
  const decisions = new Map(report.decisions.map((entry) => [nameOf(entry.sessionId), entry.decision]))

  assert.equal(decisions.get('failed'), 'recovered')
  assert.equal(decisions.get('completed'), 'skip')
  assert.equal(decisions.get('unauthorized'), 'skip')
  assert.equal(decisions.get('retired'), 'skip')
  assert.ok(report.recovered.some((entry) => nameOf(entry.sessionId) === 'failed'))
})
