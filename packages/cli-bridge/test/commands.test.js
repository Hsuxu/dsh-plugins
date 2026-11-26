import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../lib/driver.js'

function commandNames(backend) {
  const names = []
  const ctx = {
    on() {},
    effect() {},
    commands: { register(definition) { names.push(definition.name) } },
    skills: undefined,
  }
  apply(ctx, { backend })
  return names
}

test('Claude Code registers only verified commands and keeps /compact for DSH', () => {
  const names = commandNames('claude-code')
  assert.ok(names.includes('resume'))
  assert.ok(names.includes('agent'))
  assert.ok(names.includes('quota'))
  assert.ok(names.includes('cli-compact'))
  for (const name of ['config', 'usage', 'context', 'cost']) assert.ok(names.includes(name), name)
  for (const name of ['compact', 'status', 'skills', 'permissions', 'help']) assert.ok(!names.includes(name), name)
})

test('Codex registers no native commands, no cli-compact, and the plan/quota commands', () => {
  const names = commandNames('codex')
  assert.deepEqual(names.sort(), ['agent', 'codex-plan', 'quota', 'resume'].sort())
})

test('/codex-plan queues a turn instead of awaiting app-server', async () => {
  const definitions = []
  const ctx = {
    on() {},
    effect() {},
    commands: { register(definition) { definitions.push(definition) } },
    skills: undefined,
  }
  apply(ctx, { backend: 'codex' })
  const command = definitions.find((definition) => definition.name === 'codex-plan')
  assert.ok(command)
  const steered = []
  const session = { id: 'session-1', header: { cwd: process.cwd() }, snapshotEvents: () => [], append() {} }
  const result = await command.handler({
    agent: { session, steer(message) { steered.push(message) } },
    rawInput: 'inspect the repository',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.equal(steered.length, 1)
  assert.equal(steered[0].role, 'user')
  assert.match(steered[0].content[0].text, /inspect the repository/)
})

test('CodeBuddy forwards its documented local commands and offers cli-compact', () => {
  const names = commandNames('codebuddy')
  assert.ok(names.includes('resume'))
  assert.ok(names.includes('agent'))
  assert.ok(names.includes('cli-compact'))
  for (const name of ['config', 'context', 'cost', 'status', 'skills', 'permissions']) assert.ok(names.includes(name), name)
  for (const name of ['compact', 'help']) assert.ok(!names.includes(name), name)
})
