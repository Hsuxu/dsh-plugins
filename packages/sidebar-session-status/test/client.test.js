import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../lib/client.js', import.meta.url)),
  'utf8',
)

/** Minimal React surface the Client bundle uses. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useRef: (initial) => ({ current: initial }),
  useEffect: (effect) => { effect() },
}

const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
}

function loadClient() {
  let entry
  const windowStub = { __ModuleLoader__: { load: (descriptor) => { entry = descriptor } } }
  const run = new Function('window', 'require', 'document', SOURCE)
  run(windowStub, requireStub, undefined)
  return entry
}

function createCtx() {
  const calls = { locale: [], slots: [], effects: [], reorder: [] }
  const registrations = []
  const ctx = {
    locale: {
      register: (namespace, dictionary) => {
        calls.locale.push({ namespace, dictionary })
        return () => {}
      },
      bind: (namespace) => (key) => namespace + ':' + key,
    },
    slots: {
      inject: (name, factory) => {
        calls.slots.push(name)
        registrations.push(factory())
      },
      register: (options, component) => ({ options, component }),
    },
    effect: (effect, label) => {
      calls.effects.push(label)
      effect()
    },
    workspaces: {
      insertBefore: (...args) => {
        calls.reorder.push(args)
        return Promise.resolve()
      },
    },
  }
  return { ctx, calls, registrations }
}

function expose(sessionId, session, status) {
  return {
    sessionId,
    useSessions: (selector) => selector({ ids: [sessionId], byId: { [sessionId]: session } }),
    useSessionStatus: (selector) => selector(new Map([[sessionId, status]])),
    useWorkspaces: (selector) => selector({ items: [], archivedSessionIds: [], pinnedSessionIds: [] }),
    t: (key) => 'T:' + key,
  }
}

const idleStatus = { running: false, pendingInteraction: undefined, completionUnread: false }
const baseSession = { id: 'session-1', running: false, blank: false, retainedBy: { mainView: 0 } }

test('the client registers a lazy factory under the package id', () => {
  const entry = loadClient()
  assert.equal(entry.id, 'dsh-sidebar-session-status')
  const exported = entry.factory(requireStub)
  assert.deepEqual(exported.inject, ['workspaces', 'slots', 'locale'])
  assert.equal(typeof exported.apply, 'function')
  assert.equal(typeof exported.__internals, 'object')
})

test('apply registers dictionaries, styles, and both seats', () => {
  const exported = loadClient().factory(requireStub)
  const { ctx, calls, registrations } = createCtx()
  exported.apply(ctx)

  assert.equal(calls.locale.length, 1)
  assert.equal(calls.locale[0].namespace, 'dsh-sidebar-session-status')
  assert.equal(calls.effects.length, 2)
  assert.deepEqual(calls.slots, ['sidebar.session.row.trailing', 'shell.overlay'])

  const [dot, pin] = registrations
  assert.equal(dot.options.name, 'sidebar.session.row.trailing')
  assert.equal(dot.options.id, exported.__internals.DOT_ID)
  assert.equal(dot.options.order, 20)
  assert.equal(dot.options.locale, 'dsh-sidebar-session-status')

  assert.equal(pin.options.name, 'shell.overlay')
  assert.equal(pin.options.id, exported.__internals.PIN_ID)
  assert.equal(pin.options.order, 5)
})

test('the slot components resolve through the registered modules', () => {
  const exported = loadClient().factory(requireStub)
  const { ctx, registrations } = createCtx()
  exported.apply(ctx)
  const props = { sessionId: 'session-1' }
  const dot = registrations[0].component(props)
  assert.equal(dot.type, exported.__internals.SessionStatusDot)

  const overlay = registrations[1].component({})
  assert.equal(overlay.type, exported.__internals.PinActiveProject)
  assert.equal(overlay.props.ctx, ctx)
})

test('both dictionaries describe the five states', () => {
  const { DICT } = loadClient().factory(requireStub).__internals
  for (const language of ['en', 'zh']) {
    assert.ok(DICT[language], 'missing dictionary for ' + language)
    for (const key of ['state.active', 'state.completed', 'state.review', 'state.interrupted', 'state.failed']) {
      assert.equal(typeof DICT[language][key], 'string')
      assert.ok(DICT[language][key].length > 0)
    }
  }
})

test('deriveSessionState follows archived, review, active, failed, interrupted, completed, idle', () => {
  const { deriveSessionState } = loadClient().factory(requireStub).__internals
  const failed = { ...baseSession, projectionValues: { sidebarSessionStatus: { outcome: 'error', turn: 4 } } }

  assert.equal(deriveSessionState({ archived: true, hasSession: true, session: baseSession, status: idleStatus }), 'archived')
  assert.equal(deriveSessionState({ archived: false, hasSession: false, session: undefined, status: undefined }), 'idle')
  assert.equal(deriveSessionState({ archived: false, hasSession: true, session: { ...baseSession, blank: true }, status: idleStatus }), 'idle')
  assert.equal(deriveSessionState({
    archived: false,
    hasSession: true,
    session: { ...baseSession, running: true },
    status: { running: true, pendingInteraction: { kind: 'approval' }, completionUnread: false },
  }), 'review')
  assert.equal(deriveSessionState({ archived: false, hasSession: true, session: baseSession, status: { ...idleStatus, running: true } }), 'active')
  assert.equal(deriveSessionState({ archived: false, hasSession: true, session: { ...baseSession, running: true }, status: undefined }), 'active')
  assert.equal(deriveSessionState({ archived: false, hasSession: true, session: { ...baseSession, running: true }, status: idleStatus }), 'idle')
  assert.equal(deriveSessionState({ archived: false, hasSession: true, session: failed, status: idleStatus }), 'failed')
  for (const kind of ['interrupted', 'aborted']) {
    const unfinished = { ...baseSession, projectionValues: { sidebarSessionStatus: { outcome: kind, turn: 5 } } }
    assert.equal(deriveSessionState({ archived: false, hasSession: true, session: unfinished, status: idleStatus }), 'interrupted')
  }
  assert.equal(deriveSessionState({
    archived: false,
    hasSession: true,
    session: baseSession,
    status: { ...idleStatus, completionUnread: true },
  }), 'completed')
  assert.equal(deriveSessionState({ archived: false, hasSession: true, session: baseSession, status: idleStatus }), 'idle')
})

test('SessionStatusDot renders only the five tinted states', () => {
  const { SessionStatusDot, STATE_ATTRIBUTE } = loadClient().factory(requireStub).__internals

  const dot = (session, status) => SessionStatusDot(expose('session-1', session, status))

  assert.equal(dot({ ...baseSession, running: true }, { ...idleStatus, running: true }).props[STATE_ATTRIBUTE], 'active')
  assert.equal(dot(baseSession, { ...idleStatus, completionUnread: true }).props[STATE_ATTRIBUTE], 'completed')
  assert.equal(dot({ ...baseSession, projectionValues: { sidebarSessionStatus: { outcome: 'error', turn: 1 } } }, idleStatus).props[STATE_ATTRIBUTE], 'failed')
  assert.equal(dot({ ...baseSession, projectionValues: { sidebarSessionStatus: { outcome: 'interrupted', turn: 2 } } }, idleStatus).props[STATE_ATTRIBUTE], 'interrupted')
  assert.equal(dot(baseSession, { ...idleStatus, pendingInteraction: { kind: 'plan-review' } }).props[STATE_ATTRIBUTE], 'review')
  assert.equal(dot(baseSession, idleStatus), null)
  assert.equal(dot({ ...baseSession, blank: true }, idleStatus), null)

  const rendered = dot(baseSession, { ...idleStatus, completionUnread: true })
  assert.equal(rendered.type, 'span')
  assert.equal(rendered.props.role, 'img')
  assert.equal(rendered.props.title, 'T:state.completed')
  assert.equal(rendered.props['aria-label'], 'T:state.completed')
})

test('findMainViewSessionId picks the retained Session', () => {
  const { findMainViewSessionId } = loadClient().factory(requireStub).__internals
  const state = {
    ids: ['a', 'b'],
    byId: { a: { retainedBy: { mainView: 0 } }, b: { retainedBy: { mainView: 1 } } },
  }
  assert.equal(findMainViewSessionId(state), 'b')
  assert.equal(findMainViewSessionId({ ids: ['a'], byId: { a: { retainedBy: { mainView: 0 } } } }), undefined)
  assert.equal(findMainViewSessionId(undefined), undefined)
})

test('workspaceOfSession maps a Session to its Workspace group', () => {
  const { workspaceOfSession } = loadClient().factory(requireStub).__internals
  const snapshot = { items: [
    { workspaceId: 'w1', sessionIds: ['s1'] },
    { workspaceId: 'w2', sessionIds: ['s2', 's3'] },
  ] }
  assert.equal(workspaceOfSession(snapshot, 's3'), 'w2')
  assert.equal(workspaceOfSession(snapshot, 's9'), undefined)
  assert.equal(workspaceOfSession(snapshot, undefined), undefined)
})

test('PinActiveProject resolves the active Workspace before pinning', () => {
  const { PinActiveProject } = loadClient().factory(requireStub).__internals
  const sessions = {
    ids: ['s1'],
    byId: { s1: { retainedBy: { mainView: 1 } } },
  }
  const workspaces = {
    items: [{ workspaceId: 'w1', sessionIds: ['s0'] }, { workspaceId: 'w2', sessionIds: ['s1'] }],
  }
  const element = PinActiveProject({
    ctx: {},
    useSessions: (selector) => selector(sessions),
    useSessionStatus: (selector) => selector(new Map([['s1', { running: true }]])),
    useWorkspaces: (selector) => selector(workspaces),
    useWorkspaceAccess: () => true,
  })
  assert.equal(element.type.name, 'PinActiveWorkspace')
  assert.equal(element.props.workspaceId, 'w2')
  assert.equal(element.props.firstWorkspaceId, 'w1')
  assert.equal(element.props.running, true)
  assert.equal(element.props.ctx.workspaces, undefined)
})

test('PinActiveProject only reports running for a Session that runs', () => {
  const { PinActiveProject } = loadClient().factory(requireStub).__internals
  const sessions = {
    ids: ['s1'],
    byId: { s1: { running: false, retainedBy: { mainView: 1 } } },
  }
  const workspaces = { items: [{ workspaceId: 'w2', sessionIds: ['s1'] }] }

  const idle = PinActiveProject({
    ctx: {},
    useSessions: (selector) => selector(sessions),
    useSessionStatus: (selector) => selector(new Map([['s1', { running: false }]])),
    useWorkspaces: (selector) => selector(workspaces),
    useWorkspaceAccess: () => true,
  })
  assert.equal(idle.props.running, false)

  const running = PinActiveProject({
    ctx: {},
    useSessions: (selector) => selector(sessions),
    useSessionStatus: (selector) => selector(new Map([['s1', { running: true }]])),
    useWorkspaces: (selector) => selector(workspaces),
    useWorkspaceAccess: () => true,
  })
  assert.equal(running.props.running, true)

  const summaryOnly = PinActiveProject({
    ctx: {},
    useSessions: (selector) => selector({
      ids: ['s1'],
      byId: { s1: { running: true, retainedBy: { mainView: 1 } } },
    }),
    useWorkspaces: (selector) => selector(workspaces),
    useWorkspaceAccess: () => true,
  })
  assert.equal(summaryOnly.props.running, true)
})

test('PinActiveProject renders nothing while no Session is open', () => {
  const { PinActiveProject } = loadClient().factory(requireStub).__internals
  const element = PinActiveProject({
    ctx: {},
    useSessions: (selector) => selector({ ids: [], byId: {} }),
    useWorkspaces: (selector) => selector({ items: [{ workspaceId: 'w1', sessionIds: [] }] }),
    useWorkspaceAccess: () => true,
  })
  assert.equal(element, null)
})

test('PinActiveWorkspace reorders only while running, allowed, and needed', async () => {
  const exported = loadClient().factory(requireStub)
  const { PinActiveWorkspace } = exported.__internals

  const run = async (options) => {
    const { ctx, calls } = createCtx()
    PinActiveWorkspace({
      ctx,
      workspaceId: 'w2',
      firstWorkspaceId: options.firstWorkspaceId,
      running: options.running,
      useWorkspaceAccess: () => options.allowed,
    })
    await Promise.resolve()
    return calls.reorder
  }

  assert.deepEqual(await run({ allowed: true, running: true, firstWorkspaceId: 'w1' }), [['w2', 'w1']])
  assert.deepEqual(await run({ allowed: true, running: true, firstWorkspaceId: 'w2' }), [])
  assert.deepEqual(await run({ allowed: true, running: true, firstWorkspaceId: undefined }), [])
  assert.deepEqual(await run({ allowed: false, running: true, firstWorkspaceId: 'w1' }), [])
  assert.deepEqual(await run({ allowed: true, running: false, firstWorkspaceId: 'w1' }), [])
  assert.deepEqual(await run({ allowed: true, running: undefined, firstWorkspaceId: 'w1' }), [])
})
