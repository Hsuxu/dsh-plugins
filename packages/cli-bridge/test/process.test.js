import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveCommand } from '../lib/process.js'

test('resolveCommand parses an npm cmd shim on Windows', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-shim-'))
  const script = join(dir, 'cli.js')
  writeFileSync(script, '')
  const shim = join(dir, 'codebuddy.cmd')
  writeFileSync(
    shim,
    ['@ECHO off', 'SET "_prog=node"', '"%_prog%"  "%dp0%\\cli.js" %*', ''].join('\r\n'),
  )
  const [command, ...prefix] = resolveCommand(shim)
  assert.equal(command.toLowerCase(), process.execPath.toLowerCase())
  assert.deepEqual(prefix, [script])
})

test('resolveCommand unwraps a shim that points at an exe', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-shim-'))
  const exe = join(dir, 'claude.exe')
  writeFileSync(exe, '')
  const shim = join(dir, 'claude.cmd')
  writeFileSync(shim, ['@ECHO off', '"%dp0%\\claude.exe" %*', ''].join('\r\n'))
  assert.deepEqual(resolveCommand(shim), [exe])
})

test('resolveCommand leaves non-shim commands alone on POSIX', { skip: process.platform === 'win32' }, () => {
  assert.deepEqual(resolveCommand('claude'), ['claude'])
})
