import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AntigravityStream } from '../lib/antigravity-stream.js'
import { ClaudeStream } from '../lib/claude-stream.js'
import { CodexStream } from '../lib/codex-stream.js'

test('Antigravity stream translates text, tools and result', () => {
  const updates = []
  const stream = new AntigravityStream((update) => updates.push(update))
  stream.push({ event: 'init', conversation_id: 'conv-1', init: { cwd: 'C:\\w' } })
  stream.push({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 0, state: 'DONE', step_type: 'user_input', text_delta: 'hi' } })
  stream.push({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hello there' } })
  stream.push({ event: 'step_update', step_update: {
    conversation_id: 'conv-1', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: { command: 'echo hi' }, output: { stdout: 'hi\n', stderr: '', exit_code: 0 } },
  } })
  stream.push({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'Hello there', usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2, thinking_tokens: 1 } } })

  assert.equal(stream.sessionId, 'conv-1')
  assert.equal(stream.failure(), undefined)
  assert.deepEqual(updates[0], { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello there' } })
  assert.equal(updates[1].sessionUpdate, 'tool_call')
  assert.equal(updates[1].kind, 'execute')
  assert.equal(updates[2].sessionUpdate, 'tool_call_update')
  assert.equal(updates[2].status, 'completed')
  assert.equal(updates[2].rawOutput.stdout, 'hi\n')
  assert.deepEqual(stream.usage(), { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 1 })
})

test('Antigravity maps write tools and uppercase parameter names', () => {
  const updates = []
  const stream = new AntigravityStream((update) => updates.push(update))
  stream.push({ event: 'step_update', step_update: {
    conversation_id: 'conv-1', step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file',
    tool_info: { id: 'tool-1', name: 'write_to_file', parameters: { Path: 'C:\\w\\file.txt' } },
  } })
  assert.equal(updates[0].kind, 'edit')
  assert.equal(updates[0].locations[0].path, 'C:\\w\\file.txt')
  assert.match(updates[0].title, /file\.txt$/)
})

test('Antigravity failure carries the CLI error', () => {
  const stream = new AntigravityStream(() => {})
  stream.push({ event: 'result', result: { status: 'ERROR', error: { type: 'auth', message: 'authentication required' } } })
  assert.equal(stream.failure(), 'authentication required')
})

test('Claude stream emits partial text and the final usage', () => {
  const updates = []
  const stream = new ClaudeStream((update) => updates.push(update))
  stream.push({ type: 'system', session_id: 's1' })
  stream.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } })
  stream.push({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }] } })
  stream.push({ type: 'result', is_error: false, usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } })
  assert.equal(stream.sessionId, 's1')
  assert.deepEqual(updates.at(-1), { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } })
  assert.equal(stream.recordable({ type: 'stream_event' }), false)
  assert.deepEqual(stream.usage(), { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 })
})

test('Claude local command result becomes visible text', () => {
  const updates = []
  const stream = new ClaudeStream((update) => updates.push(update))
  stream.push({ type: 'result', is_error: false, result: 'Not enough messages to compact.', local_command: 'compact' })
  assert.deepEqual(updates, [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Not enough messages to compact.' } }])
  assert.equal(stream.failure(), undefined)
})

test('Codex stream emits messages and tool results', () => {
  const updates = []
  const stream = new CodexStream((update) => updates.push(update))
  stream.push({ type: 'thread.started', thread_id: 't1' })
  stream.push({ type: 'item.completed', item: { type: 'agent_message', text: 'Working' } })
  stream.push({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } })
  stream.push({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt', exit_code: 0 } })
  stream.push({ type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 3 } })
  assert.equal(stream.sessionId, 't1')
  assert.equal(stream.failure(), undefined)
  assert.ok(updates.some((update) => update.sessionUpdate === 'agent_message_chunk'))
  assert.ok(updates.some((update) => update.sessionUpdate === 'tool_call' && update.kind === 'execute'))
  assert.deepEqual(stream.usage(), { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 })
})
