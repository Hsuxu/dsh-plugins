import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexPlanStream } from '../lib/codex-plan-stream.js'
import { PLAN_TEXT_LIMIT, latestPlanEvent, planView } from '../lib/plan.js'

test('planView hides inactive records and caps plan text', () => {
  assert.equal(planView(null), null)
  assert.equal(planView({ active: false, pending: false, reviewPending: false }), null)
  const view = planView({
    active: true,
    pending: false,
    reviewPending: true,
    threadId: 'thread-1',
    plan: 'x'.repeat(PLAN_TEXT_LIMIT + 10),
    requestId: 'request-1',
    updatedAt: 42,
  })
  assert.equal(view.active, true)
  assert.equal(view.reviewPending, true)
  assert.equal(view.threadId, 'thread-1')
  assert.equal(view.plan.length, PLAN_TEXT_LIMIT)
  assert.equal(view.updatedAt, 42)
})

test('latestPlanEvent reads the last plan record from the session log', () => {
  const session = {
    snapshotEvents: () => [
      { type: 'plugin:dsh-cli-bridge/plan', data: { active: true, pending: true, plan: '' } },
      { type: 'plugin:dsh-cli-bridge/plan', data: { active: true, pending: false, reviewPending: true, plan: '# Plan' } },
    ],
  }
  assert.equal(latestPlanEvent(session).plan, '# Plan')
  assert.equal(latestPlanEvent({ snapshotEvents: () => [] }), undefined)
})

test('CodexPlanStream prefers the completed plan item and records usage', async () => {
  const stream = new CodexPlanStream()
  stream.push('item/plan/delta', { delta: 'draft' })
  stream.push('item/agentMessage/delta', { delta: 'fallback' })
  stream.push('item/completed', { item: { type: 'plan', text: '# Final plan\n\n1. Ship it' } })
  stream.push('thread/tokenUsage/updated', {
    tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 16 } },
  })
  stream.push('turn/completed', { turn: { status: 'completed' } })
  await stream.done
  assert.equal(stream.text(), '# Final plan\n\n1. Ship it')
  assert.equal(stream.usage.totalTokens, 16)
  assert.equal(stream.failure(), undefined)
})

test('CodexPlanStream reports a failed turn', async () => {
  const stream = new CodexPlanStream()
  stream.push('turn/completed', { turn: { status: 'failed', error: { message: 'model rejected' } } })
  await stream.done
  assert.equal(stream.failure(), 'model rejected')
})
