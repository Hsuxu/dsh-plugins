import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKENDS, COMMAND_SUPPORT, RESERVED_COMMANDS, isAuthError, nativeCommands, parseAgyModels, parseCommand, printForce, resolveBackend } from '../lib/backends.js'

test('parseCommand honours quotes and backslash escapes', () => {
  assert.deepEqual(parseCommand('claude --model "a b" --flag=1'), ['claude', '--model', 'a b', '--flag=1'])
  assert.deepEqual(parseCommand('C:\\Program\\ Files\\claude.exe -p'), ['C:\\Program Files\\claude.exe', '-p'])
  assert.throws(() => parseCommand('claude "unclosed'), /unclosed/)
})

test('each print backend builds its own argv', () => {
  const claude = resolveBackend('claude-code', { command: 'C:\\bin\\claude.exe --foo' })
  assert.equal(claude.argv[0], 'C:\\bin\\claude.exe')
  const claudeArgv = claude.printArgv({ model: 'opus', resume: 'abc', force: true, prompt: '' })
  assert.ok(claudeArgv.includes('-p'))
  assert.ok(claudeArgv.includes('--verbose'))
  assert.deepEqual(claudeArgv.slice(claudeArgv.indexOf('--model'), claudeArgv.indexOf('--model') + 2), ['--model', 'opus'])
  assert.deepEqual(claudeArgv.slice(claudeArgv.indexOf('--resume'), claudeArgv.indexOf('--resume') + 2), ['--resume', 'abc'])
  assert.ok(claudeArgv.includes('--permission-mode'))

  const codex = resolveBackend('codex')
  const codexArgv = codex.printArgv({ model: 'gpt-6-sol', effort: 'high', resume: 'thread', force: true, prompt: 'hello' })
  assert.equal(codexArgv[1], 'exec')
  assert.deepEqual(codexArgv.slice(1, 3), ['exec', 'resume'])
  assert.ok(codexArgv.includes('--json'))
  assert.equal(codexArgv.at(-1), 'hello')

  const agy = resolveBackend('antigravity')
  const agyArgv = agy.printArgv({ model: 'gemini-4-neon-high', effort: 'xhigh', resume: 'uuid', force: true, prompt: 'hi' })
  assert.ok(agyArgv.includes('--output-format'))
  assert.equal(agyArgv[agyArgv.indexOf('--model') + 1], 'gemini-4-neon')
  assert.equal(agyArgv[agyArgv.indexOf('--conversation') + 1], 'uuid')
  assert.equal(agyArgv[agyArgv.indexOf('--effort') + 1], 'xhigh')
  assert.equal(agyArgv.at(-1), 'hi')
  const agyBare = agy.printArgv({ model: 'gemini-4-neon-high', prompt: 'hi' })
  assert.equal(agyBare[agyBare.indexOf('--model') + 1], 'gemini-4-neon-high')
  assert.ok(!agyBare.includes('--effort'))

  const codebuddy = resolveBackend('codebuddy')
  const codebuddyArgv = codebuddy.printArgv({ model: 'default-model', effort: 'high', resume: 'sid', force: true, prompt: 'hello' })
  assert.ok(codebuddyArgv.includes('-p'))
  assert.ok(codebuddyArgv.includes('stream-json'))
  assert.equal(codebuddyArgv[codebuddyArgv.indexOf('--model') + 1], 'default-model')
  assert.equal(codebuddyArgv[codebuddyArgv.indexOf('--effort') + 1], 'high')
  assert.equal(codebuddyArgv[codebuddyArgv.indexOf('--resume') + 1], 'sid')
  assert.ok(codebuddyArgv.includes('--dangerously-skip-permissions'))
  assert.equal(codebuddyArgv.at(-1), 'hello')
})

test('permission deny never force-approves', () => {
  assert.equal(printForce({ id: 'codex', permission: 'deny' }), false)
  assert.equal(printForce({ id: 'codex', permission: 'allow' }), true)
  assert.equal(printForce({ id: 'claude-code', permission: 'allow' }, 0), false)
})

test('native command whitelists never shadow DSH commands', () => {
  for (const backendId of Object.keys(COMMAND_SUPPORT)) {
    for (const name of nativeCommands(backendId)) assert.equal(RESERVED_COMMANDS.has(name), false, name)
  }
  assert.deepEqual(nativeCommands('codex'), [])
  assert.equal(COMMAND_SUPPORT.codex.compact, false)
  assert.equal(COMMAND_SUPPORT['claude-code'].compact, true)
  assert.ok(nativeCommands('claude-code').includes('config'))
  assert.ok(!nativeCommands('claude-code').includes('status'))
  assert.ok(nativeCommands('antigravity').includes('usage'))
  assert.ok(nativeCommands('antigravity').includes('config'))
  assert.ok(!nativeCommands('antigravity').includes('status'))
  assert.ok(!nativeCommands('antigravity').includes('context'))
  assert.ok(nativeCommands('codebuddy').includes('config'))
  assert.ok(nativeCommands('codebuddy').includes('status'))
  assert.equal(COMMAND_SUPPORT.codebuddy.compact, true)
  assert.ok(BACKENDS.antigravity)
  assert.ok(BACKENDS.codebuddy)
})

test('parseAgyModels reads slug and display name', () => {
  const models = parseAgyModels('Fetching models...\n\ngemini-4-neon-xhigh  Gemini 4 Neon (XHigh)\ngemini-3.8-flash-high  Gemini 3.8 Flash (High)\n')
  assert.deepEqual(models.map((model) => [model.id, model.name]), [
    ['gemini-4-neon-xhigh', 'Gemini 4 Neon (XHigh)'],
    ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ])
  assert.equal(models[0].defaultEffort, 'xhigh')
  assert.deepEqual(models[0].efforts, ['xhigh'])
})

test('auth errors are recognized', () => {
  assert.equal(isAuthError(Object.assign(new Error('x'), { authRequired: true })), true)
  assert.equal(isAuthError(new Error('authentication required')), true)
  assert.equal(isAuthError(new Error('boom')), false)
})
