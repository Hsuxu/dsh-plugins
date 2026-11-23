import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  bindingView,
  clearResumeResultText,
  escapeProjectDir,
  foldClaudeTranscript,
  isClearResumeToken,
  isSessionId,
  listBackendSessions,
  parseCodexIndex,
  resumeResultText,
} from '../lib/sessions.js'

test('binding view and resume text are stable', () => {
  assert.deepEqual(bindingView({ backend: 'codex', chatId: 'thread-1', title: 'Fix bug', resumed: true }), {
    backend: 'codex',
    id: 'thread-1',
    title: 'Fix bug',
    resumed: true,
  })
  assert.equal(bindingView({ cleared: true }), null)
  assert.equal(resumeResultText('Fix bug', 'thread-1'), 'Resuming "Fix bug" (thread-1).')
  assert.equal(resumeResultText('', 'thread-1'), 'Resuming session thread-1.')
  assert.equal(clearResumeResultText('thread-1'), 'Cleared resumed session (thread-1).')
  assert.equal(clearResumeResultText(), 'No resumed session to clear.')
  assert.equal(isClearResumeToken('OFF'), true)
  assert.equal(isSessionId('thread-1'), true)
  assert.equal(isSessionId('bad id'), false)
})

test('Codex index rows sort current workspace first', () => {
  const text = [
    JSON.stringify({ id: 'other', thread_name: 'Other', updated_at: '2026-01-01T00:00:00Z', cwd: 'C:\\other' }),
    JSON.stringify({ id: 'current', thread_name: 'Current', updated_at: '2025-01-01T00:00:00Z', cwd: 'C:\\work' }),
  ].join('\n')
  const rows = parseCodexIndex(text, 'C:\\work')
  assert.deepEqual(rows.map((row) => [row.id, row.currentWorkspace]), [
    ['other', false],
    ['current', true],
  ])
  assert.equal(rows[1].title, 'Current')
})

test('Claude transcript folds a title from the first user prompt', () => {
  assert.deepEqual(foldClaudeTranscript([
    { type: 'custom-title', customTitle: 'Named' },
    { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, cwd: 'C:\\w' },
  ]), { title: 'Named', cwd: 'C:\\w' })
})

test('lists Codex and Antigravity sessions from a home directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cli-test-'))
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex', 'session_index.jsonl'), `${JSON.stringify({ id: 'thread-1', thread_name: 'Thread', updated_at: '2026-02-01T00:00:00Z', cwd: 'C:\\work' })}\n`)
  const conversations = join(home, '.gemini', 'antigravity-cli', 'conversations')
  await mkdir(conversations, { recursive: true })
  await writeFile(join(conversations, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.db'), '')

  const codex = await listBackendSessions('codex', 'C:\\work', { home })
  assert.equal(codex[0].id, 'thread-1')
  assert.equal(codex[0].currentWorkspace, true)

  const antigravity = await listBackendSessions('antigravity', 'C:\\work', { home })
  assert.equal(antigravity[0].id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')

  const codebuddyDir = join(home, '.codebuddy', 'projects', escapeProjectDir('C:\\work'))
  await mkdir(codebuddyDir, { recursive: true })
  await writeFile(join(codebuddyDir, 'cb-session.jsonl'), `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hello codebuddy' }] }, cwd: 'C:\\work' })}\n`)
  const codebuddy = await listBackendSessions('codebuddy', 'C:\\work', { home })
  assert.equal(codebuddy[0].id, 'cb-session')
  assert.equal(codebuddy[0].title, 'hello codebuddy')
})
