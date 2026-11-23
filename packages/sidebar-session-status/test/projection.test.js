import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NO_TURN_OUTCOME,
  PROJECTION_KEY,
  apply,
  init,
  projectionDefinition,
  stateSchema,
  view,
  viewSchema,
} from '../lib/projection.js'

const ended = (turn, kind) => ({ type: 'turn/end', data: { turn, reason: { kind } } })

test('init starts before any turn has ended', () => {
  assert.deepEqual(init(), { outcome: NO_TURN_OUTCOME, turn: -1 })
})

test('folds a completed turn', () => {
  assert.deepEqual(apply(init(), ended(2, 'completed')), { outcome: 'completed', turn: 2 })
})

test('records an error turn so the sidebar can mark it failed', () => {
  const state = apply(init(), ended(3, 'error'))
  assert.deepEqual(state, { outcome: 'error', turn: 3 })
})

test('preserves unknown turn kinds for forward compatibility', () => {
  assert.equal(apply(init(), ended(1, 'max-tokens')).outcome, 'max-tokens')
})

test('ignores events that are not turn/end with the same reference', () => {
  const state = init()
  assert.equal(apply(state, { type: 'message/user', data: {} }), state)
  assert.equal(apply(state, null), state)
})

test('ignores turn/end without a usable reason', () => {
  const state = { outcome: 'error', turn: 4 }
  assert.equal(apply(state, { type: 'turn/end', data: { turn: 5 } }), state)
  assert.equal(apply(state, { type: 'turn/end', data: { turn: 5, reason: { kind: '' } } }), state)
})

test('returns the same reference when the outcome is unchanged', () => {
  const state = { outcome: 'error', turn: 4 }
  assert.equal(apply(state, ended(4, 'error')), state)
})

test('the wire view is the state reference', () => {
  const state = { outcome: 'completed', turn: 1 }
  assert.equal(view(state), state)
})

test('the invalid state is not produced by a malformed event', () => {
  const state = apply(init(), { type: 'turn/end', data: { turn: 'x', reason: { kind: 'error' } } })
  assert.deepEqual(state, { outcome: 'error', turn: -1 })
})

test('schemas accept the unit state and reject malformed values', () => {
  const state = { outcome: 'error', turn: 1 }
  assert.equal(stateSchema.parse(state), state)
  assert.equal(viewSchema.parse(state), state)
  for (const bad of [null, [], {}, { outcome: '', turn: 1 }, { outcome: 'ok', turn: -2 }, { outcome: 'ok', turn: 1.5 }]) {
    assert.throws(() => stateSchema.parse(bad), TypeError)
    assert.throws(() => viewSchema.parse(bad), TypeError)
  }
})

test('the definition is a summary projection with a stable key', () => {
  assert.equal(projectionDefinition.key, PROJECTION_KEY)
  assert.equal(projectionDefinition.key, 'sidebarSessionStatus')
  assert.equal(projectionDefinition.stateVersion, 1)
  assert.equal(projectionDefinition.wire.summary, true)
  const state = projectionDefinition.init()
  assert.equal(projectionDefinition.wire.view(state), state)
  assert.equal(typeof projectionDefinition.apply, 'function')
})
