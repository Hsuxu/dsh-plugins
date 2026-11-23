import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurnWriter } from '../lib/turn-writer.js'

function fakeSession() {
  const events = []
  return {
    events,
    append(type, data, options) {
      events.push({ type, data, options })
      return { seq: events.length }
    },
  }
}

test('TurnWriter writes steps and a tool result after its call', () => {
  const session = fakeSession()
  const writer = new TurnWriter({ session, turn: 1, provider: 'cli-codex', model: 'gpt-6-sol', cwd: 'C:\\work' })
  writer.admit([{ role: 'user', content: [{ type: 'text', text: 'run it' }] }])
  writer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running' } })
  writer.update({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'execute', title: 'ls', rawInput: { command: 'ls' }, status: 'in_progress' })
  writer.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { stdout: 'a.txt', stderr: '', exitCode: 0 } })
  writer.finish()

  const types = session.events.map((event) => event.type)
  assert.deepEqual(types, ['user/message', 'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end'])
  const message = session.events[2].data.message
  assert.deepEqual(message.content.map((block) => block.type), ['text', 'tool-call'])
  const result = session.events[4].data
  assert.equal(result.message.content[0].text, 'a.txt\n[exit code: 0]')
  assert.equal(result.message.isError, false)
  assert.equal(result.meta.cli.kind, 'execute')
})
