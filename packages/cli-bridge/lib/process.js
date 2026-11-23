import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const WINDOWS = process.platform === 'win32'
const shimCache = new Map()

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Expand the handful of cmd.exe variables a generated npm shim uses. */
function expandShimVars(text, vars) {
  return text.replace(/%([^%]+)%/g, (match, name) => {
    const key = name.toLowerCase()
    if (key in vars) return vars[key]
    if (key === 'comspec') return process.env.ComSpec ?? 'cmd.exe'
    return match
  })
}

function quotedParts(text) {
  return [...text.matchAll(/"([^"]*)"/g)].map((match) => match[1])
}

/**
 * npm installs a `.cmd` shim on Windows, and CreateProcess cannot execute it
 * directly. Read the shim's exec line and return the real program plus any
 * prefix arguments (for example `node.exe` + the CLI's JavaScript entry).
 */
function resolveShim(cmdPath) {
  const cached = shimCache.get(cmdPath)
  if (cached) return cached
  const dir = dirname(cmdPath)
  const text = readFileSync(cmdPath, 'utf8')
  const vars = { dp0: dir, '~dp0': dir }
  const progCandidates = [...text.matchAll(/SET\s+"?_prog=([^"\r\n]+)"?/gi)].map((match) => match[1].trim())
  for (const candidate of progCandidates) {
    const expanded = expandShimVars(candidate, vars)
    if (expanded.toLowerCase() === 'node') {
      vars._prog = process.execPath
      break
    }
    if (isFile(expanded)) {
      vars._prog = expanded
      break
    }
  }
  const execLine = text
    .split(/\r?\n/)
    .filter((line) => line.includes('%*') && !/^\s*(?:@?rem\b|::)/i.test(line))
    .pop()
  if (!execLine) throw new Error(`cannot resolve command shim: ${cmdPath}`)
  const parts = quotedParts(expandShimVars(execLine, vars)).filter((part) => part !== '%*' && !part.includes('%*'))
  let index = parts.findIndex((part) => /\.(?:exe|com)$/i.test(part))
  if (index === -1) index = 0
  let program = parts[index] ?? cmdPath
  const prefix = parts.slice(index + 1)
  if (!/\.(?:exe|com)$/i.test(program)) {
    prefix.unshift(program)
    program = process.execPath
  }
  const resolved = [program, ...prefix]
  shimCache.set(cmdPath, resolved)
  return resolved
}

function resolveFile(path) {
  if (!WINDOWS || !/\.(?:cmd|bat)$/i.test(path) || !isFile(path)) return [path]
  return resolveShim(path)
}

/**
 * Installer locations the CLI writes to without updating the PATH of an
 * already-running DSH process. `agy` is the only current case: its Windows
 * installer writes `%LOCALAPPDATA%/agy/bin/agy.exe`, and the POSIX installer
 * writes `~/.local/bin/agy`.
 */
export function agyFallbacks() {
  if (WINDOWS) {
    const local = process.env.LOCALAPPDATA
    return local ? [join(local, 'agy', 'bin', 'agy.exe'), join(local, 'Programs', 'agy', 'agy.exe')] : []
  }
  return [join(homedir(), '.local', 'bin', 'agy')]
}

/**
 * The executable plus any prefix arguments for a launch line. On Windows this
 * turns a `.cmd`/`.bat` shim on PATH into the program it runs, because
 * `spawn`/`execFile` cannot start a shim directly.
 */
export function resolveCommand(command) {
  if (!WINDOWS) return [command]
  if (command.includes('/') || command.includes('\\')) return resolveFile(command)
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((ext) => ext.toLowerCase())
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const ext of ['.exe', '.cmd', '.bat', '.com']) {
    if (!exts.includes(ext)) continue
    const name = command.toLowerCase().endsWith(ext) ? command : command + ext
    for (const dir of dirs) {
      const candidate = join(dir, name)
      if (isFile(candidate)) return resolveFile(candidate)
    }
  }
  if (command.toLowerCase() === 'agy') {
    const fallback = agyFallbacks().find((candidate) => isFile(candidate))
    if (fallback) return resolveFile(fallback)
  }
  return [command]
}

/**
 * Spawn an agent CLI. Detached on POSIX gives the CLI its own process group, so a
 * turn that is stopped takes down the helpers it started; on Windows taskkill /T
 * walks the tree instead, and a hidden console avoids a flash for every turn.
 */
export function spawnAgent(argv, options) {
  const [command, ...prefix] = resolveCommand(argv[0])
  return spawn(command, [...prefix, ...argv.slice(1)], {
    ...options,
    detached: !WINDOWS,
    windowsHide: true,
  })
}

/** Signal the CLI's process group where the platform has one, else the child itself. */
export function signalAgent(child, signal = 'SIGTERM') {
  if (process.platform === 'win32' || !child.pid) {
    child.kill()
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill()
  }
}

async function processTable() {
  if (process.platform === 'linux') {
    try {
      const { readdir, readFile } = await import('node:fs/promises')
      const entries = await readdir('/proc')
      const rows = []
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue
        try {
          const stat = await readFile(`/proc/${entry}/stat`, 'utf8')
          const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
          rows.push({ pid: Number(entry), ppid: Number(tail[1]), pgid: Number(tail[2]) })
        } catch {
          // the process exited while we looked at it
        }
      }
      return rows
    } catch {
      return []
    }
  }
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
    return stdout
      .split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), started: m[4] }))
  } catch {
    return []
  }
}

function addDescendants(table, roots) {
  const children = new Map()
  for (const row of table) {
    const list = children.get(row.ppid) ?? []
    list.push(row)
    children.set(row.ppid, list)
  }
  const found = new Set(roots)
  const queue = [...roots]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (found.has(child.pid)) continue
      found.add(child.pid)
      queue.push(child.pid)
    }
  }
  return found
}

function signalDescendants(table, roots, signal) {
  for (const pid of addDescendants(table, roots)) {
    if (roots.has(pid)) continue
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

const stopping = new WeakMap()

/**
 * Stop a CLI process and the descendants it started, escalating to SIGKILL (or
 * taskkill /F on Windows) after the grace period, and resolve once they are gone.
 */
export function stopAgent(child, graceMs = 3000) {
  const pending = stopping.get(child)
  if (pending) return pending
  const stopped = new Promise((resolve) => {
    const finish = () => {
      child.removeAllListeners()
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve()
    }
    if (!child.pid) {
      child.kill()
      finish()
      return
    }
    if (process.platform === 'win32') {
      run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: graceMs + 2000, windowsHide: true }).then(finish, () => {
        child.kill('SIGKILL')
        finish()
      })
      return
    }
    let done = false
    const finishOnce = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      finish()
    }
    const timer = setTimeout(async () => {
      const table = await processTable()
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      signalDescendants(table, new Set([child.pid]), 'SIGKILL')
      finishOnce()
    }, graceMs)
    const tablePromise = processTable()
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
    tablePromise.then((table) => {
      signalDescendants(table, new Set([child.pid]), 'SIGTERM')
      const poll = () => {
        if (done) return
        processTable().then((current) => {
          if (addDescendants(current, new Set([child.pid])).size <= 1) finishOnce()
          else setTimeout(poll, 100)
        }, finishOnce)
      }
      poll()
    }, finishOnce)
  })
  stopping.set(child, stopped)
  return stopped
}
