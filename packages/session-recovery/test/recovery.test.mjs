/** Boot-scan behaviour of the host half, exercised with a fake Cordis context. */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../lib/index.js'

const cwd = process.cwd()

const userMessage = (text, kind = 'user') => ({
  type: 'user/message',
  data: { id: `m-${text}`, content: [{ type: 'text', text }], source: { kind } },
})

const turn = (reason) => [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'turn/end', data: { turn: 1, reason } },
]

const MARKER = '[session-recovery]'

const logs = {
  completed: [userMessage('do it'), ...turn({ kind: 'completed' })],
  failed: [userMessage('do it'), ...turn({ kind: 'error', error: { code: 'SERVER', message: 'boom' } })],
  interrupted: [userMessage('do it'), ...turn({ kind: 'interrupted' })],
  crashed: [userMessage('do it'), { type: 'turn/start', data: { turn: 1 } }],
  stopped: [userMessage('do it'), ...turn({ kind: 'aborted', reason: { kind: 'user' } })],
  disposed: [userMessage('do it'), ...turn({ kind: 'aborted', reason: { kind: 'disposed' } })],
  unauthorized: [userMessage('do it'), ...turn({ kind: 'error', error: { code: 'AUTH', message: 'no key' } })],
  recovered: [
    userMessage('do it'),
    ...turn({ kind: 'error', error: { code: 'TIMEOUT', message: 'slow' } }),
    userMessage(`${MARKER} continuing`),
    ...turn({ kind: 'error', error: { code: 'TIMEOUT', message: 'slow' } }),
    userMessage(`${MARKER} continuing`),
    ...turn({ kind: 'error', error: { code: 'TIMEOUT', message: 'slow' } }),
  ],
  blank: [],
  live: [userMessage('do it'), ...turn({ kind: 'error', error: { code: 'SERVER' } })],
  subagent: [userMessage('do it'), ...turn({ kind: 'error', error: { code: 'SERVER' } })],
}

const records = Object.keys(logs).map((id, index) => ({
  header: {
    id,
    createdAt: 1000 - index,
    cwd,
    origin: id === 'subagent' ? 'subagent' : undefined,
  },
  live: id === 'live',
}))

const recovered = []

function createContext({ persistence = true } = {}) {
  const sent = recovered
  const agents = {}

  for (const record of records) {
    agents[record.header.id] = {
      status: 'idle',
      session: { id: record.header.id },
      followup(message) {
        sent.push({ sessionId: record.header.id, text: message.content[0].text, source: message.source.kind })
      },
    }
  }

  const services = {
    sessionController: {
      async resolveAgent(sessionId) {
        return agents[sessionId] ? { agent: agents[sessionId] } : { error: { code: 'session/not-found' } }
      },
    },
  }

  if (persistence) {
    services.sessionPersistence = {
      async open(sessionId) {
        return {
          read: async () => ({ events: logs[sessionId] ?? [] }),
          close: async () => {},
        }
      },
    }
  }

  const log = []
  return {
    log,
    ctx: {
      effect(effect) {
        return effect()
      },
      logger: () => ({
        info: (format, message) => log.push(`info ${message ?? format}`),
        warn: (format, message) => log.push(`warn ${message ?? format}`),
        debug: () => {},
        error: () => {},
      }),
      get: (name) => services[name],
      sessions: {
        get: () => undefined,
        flush: async () => true,
      },
      sessionQuery: {
        listSessions: async () => records,
        readSession: async (sessionId) => ({ events: logs[sessionId] ?? [] }),
      },
      agents: {
        get: (sessionId) => agents[sessionId],
      },
    },
  }
}

test('recovers only the sessions whose last turn failed or never finished', async () => {
  const { ctx, log } = createContext()

  apply(ctx, { bootDelayMs: 0, staggerMs: 0, maxSessions: 10 })
  await new Promise((resolve) => setTimeout(resolve, 300))

  const sessionIds = recovered.map((entry) => entry.sessionId).sort()
  assert.deepEqual(sessionIds, ['crashed', 'disposed', 'failed', 'interrupted'])

  for (const entry of recovered) {
    assert.equal(entry.source, 'user')
    assert.ok(entry.text.startsWith(MARKER))
    assert.ok(entry.text.includes('{reason}') === false)
  }

  assert.ok(log.some((line) => line.startsWith('info recovered 4 session(s)')))
})

test('a disabled plugin never queues work', async () => {
  const { ctx } = createContext()
  const before = recovered.length

  apply(ctx, { bootDelayMs: 0, enabled: false })
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(recovered.length, before)
})
