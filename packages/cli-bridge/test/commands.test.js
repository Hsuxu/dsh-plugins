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

test('Codex registers no native commands, no cli-compact, and the quota command', () => {
  const names = commandNames('codex')
  assert.deepEqual(names.sort(), ['agent', 'quota', 'resume'].sort())
})

test('CodeBuddy forwards its documented local commands and offers cli-compact', () => {
  const names = commandNames('codebuddy')
  assert.ok(names.includes('resume'))
  assert.ok(names.includes('agent'))
  assert.ok(names.includes('cli-compact'))
  for (const name of ['config', 'context', 'cost', 'status', 'skills', 'permissions']) assert.ok(names.includes(name), name)
  for (const name of ['compact', 'help']) assert.ok(!names.includes(name), name)
})
