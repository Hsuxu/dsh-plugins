import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * Local CLI sessions a cli mode can bind with `/resume`. Parsers never import
 * a transcript into the DSH log; they only recover an id, a title and a time
 * so the next turn can pass the CLI its own `--resume` / `--conversation` flag.
 */

export const BINDING_EVENT = 'plugin:dsh-cli-bridge/binding'
export const CLEAR_RESUME_TOKENS = new Set(['off', 'clear', 'cancel', 'none', 'stop'])

const LIST_LIMIT = 50
const CURRENT_CAP = 80
const OTHER_CAP = 80
const LINE_LIMIT = 200_000

/** Whether a `/resume` argument asks to clear the current binding. */
export function isClearResumeToken(raw) {
  return CLEAR_RESUME_TOKENS.has(String(raw ?? '').trim().toLowerCase())
}

/** Latest `plugin:dsh-cli-bridge/binding` on a session, if one was recorded. */
export function readBinding(session) {
  let binding
  for (const event of session?.snapshotEvents?.() ?? []) {
    if (event.type === 'agent-preset/selected') {
      binding = undefined
      continue
    }
    if (event.type !== BINDING_EVENT) continue
    binding = event.data?.cleared ? undefined : event.data
  }
  return binding
}

/** Title safe to show in the composer bar, the transcript card, and the sidebar. */
export function cleanResumeTitle(title) {
  const clean = String(title ?? '').replace(/["\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, 200) : ''
}

/**
 * Client-facing binding. Absent or unusable events become null so the
 * projection schema can reject anything else.
 * @param {unknown} data
 * @returns {{ backend: string, id: string, title: string | null, resumed: boolean } | null}
 */
export function bindingView(data) {
  if (!data || typeof data !== 'object' || data.cleared) return null
  const id = typeof data.chatId === 'string' ? data.chatId : ''
  if (!id) return null
  const title = cleanResumeTitle(data.title)
  return {
    backend: typeof data.backend === 'string' ? data.backend : '',
    id,
    title: title || null,
    resumed: data.resumed === true,
  }
}

/** Stable command result. The transcript card parses this exact shape. */
export function resumeResultText(title, id) {
  const clean = cleanResumeTitle(title)
  return clean ? `Resuming "${clean}" (${id}).` : `Resuming session ${id}.`
}

/** Stable command result when clearing a resume binding. */
export function clearResumeResultText(id) {
  return id ? `Cleared resumed session (${id}).` : 'No resumed session to clear.'
}

/** Ids safe to place after `--resume` or `--conversation` (no flags, no whitespace). */
export function isSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][\w.:-]{0,199}$/.test(id)
}

/** Claude Code project directory: every non-alphanumeric becomes `-`. */
export function escapeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Sessions for one backend, current workspace first.
 * @param options.home - user directory that holds `.claude`, `.codex`, `.gemini`
 * @param options.limit - how many rows to return
 */
export async function listBackendSessions(backendId, cwd, options = {}) {
  const home = options.home ?? homedir()
  const limit = options.limit ?? LIST_LIMIT
  let rows = []
  switch (backendId) {
    case 'claude-code':
      rows = await scanProjectTranscripts(join(home, '.claude', 'projects'), cwd, absorbClaude)
      break
    case 'codex':
      rows = await scanCodex(join(home, '.codex', 'session_index.jsonl'), cwd)
      break
    case 'antigravity':
      rows = await scanAntigravity(join(home, '.gemini', 'antigravity-cli', 'conversations'), cwd)
      break
    case 'codebuddy':
      rows = await scanProjectTranscripts(join(home, '.codebuddy', 'projects'), cwd, absorbClaude)
      break
    default:
      rows = []
  }
  return sortSessions(rows).slice(0, limit)
}

/** Title and cwd folded from Claude Code JSONL events. */
export function foldClaudeTranscript(events) {
  const state = {}
  for (const event of events) absorbClaude(state, event)
  return finishTranscript(state)
}

/** Rows of `~/.codex/session_index.jsonl`. */
export function parseCodexIndex(text, cwd) {
  const rows = []
  for (const line of String(text ?? '').split(/\n/)) {
    if (!line.trim()) continue
    let item
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof item?.id !== 'string' || !isSessionId(item.id)) continue
    const dir = typeof item.cwd === 'string' ? item.cwd : undefined
    rows.push({
      id: item.id,
      title: oneLine(item.thread_name || item.title || item.id),
      updatedAt: Date.parse(item.updated_at) || 0,
      cwd: dir,
      currentWorkspace: samePath(dir, cwd),
    })
  }
  return rows
}

function absorbClaude(state, event) {
  if (!event || typeof event !== 'object') return
  if (event.type === 'custom-title') {
    const title = event.customTitle ?? event.title
    if (typeof title === 'string' && title.trim()) state.custom = oneLine(title)
  } else if (event.type === 'last-prompt' && typeof event.lastPrompt === 'string' && event.lastPrompt.trim()) {
    state.prompt = oneLine(event.lastPrompt)
  } else if (event.type === 'user' && !event.isSidechain && !state.user) {
    const text = textOfContent(event.message?.content ?? event.content)
    if (text) state.user = oneLine(text)
  }
  if (typeof event.cwd === 'string') state.cwd = event.cwd
}

function finishTranscript(state) {
  return { title: state.custom || state.prompt || state.user || 'Untitled session', cwd: state.cwd }
}

async function scanProjectTranscripts(root, cwd, absorb) {
  let dirs
  try {
    dirs = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const wanted = escapeProjectDir(cwd)
  const current = []
  const other = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const files = await jsonlFiles(join(root, dir.name))
    const bucket = dir.name === wanted ? current : other
    for (const file of files) bucket.push({ ...file, dirName: dir.name })
  }
  const chosen = [...newest(current, CURRENT_CAP), ...newest(other, OTHER_CAP)]
  const rows = []
  for (const file of chosen) {
    const state = await foldFile(file.path, absorb)
    rows.push({
      id: file.id,
      title: state.title,
      updatedAt: file.mtimeMs,
      cwd: state.cwd,
      currentWorkspace: file.dirName === wanted || samePath(state.cwd, cwd),
    })
  }
  return rows
}

async function jsonlFiles(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const files = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      files.push({ path, id: name.slice(0, -'.jsonl'.length), mtimeMs: info.mtimeMs })
    } catch {
      continue
    }
  }
  return files
}

function newest(files, cap) {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, cap)
}

async function foldFile(path, absorb) {
  const state = {}
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) })
    for await (const line of lines) {
      if (!line.trim() || line.length > LINE_LIMIT) continue
      try {
        absorb(state, JSON.parse(line))
      } catch {
        continue
      }
    }
  } catch {
    return finishTranscript(state)
  }
  return finishTranscript(state)
}

async function scanCodex(file, cwd) {
  try {
    return parseCodexIndex(await readFile(file, 'utf8'), cwd)
  } catch {
    return []
  }
}

/**
 * Antigravity keeps one SQLite database per conversation. The title lives in
 * the workspace index, so the picker shows the id and the file time instead of
 * opening the database; the CLI still receives its own `--conversation <id>`.
 */
async function scanAntigravity(root, cwd) {
  let names
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.db')) continue
    const id = name.slice(0, -'.db'.length)
    if (!isSessionId(id)) continue
    try {
      const info = await stat(join(root, name))
      if (!info.isFile()) continue
      rows.push({ id, title: `Antigravity session ${id.slice(0, 8)}`, updatedAt: info.mtimeMs, cwd: undefined, currentWorkspace: false })
    } catch {
      continue
    }
  }
  return rows
}

function sortSessions(rows) {
  return [...rows].sort((a, b) => Number(b.currentWorkspace) - Number(a.currentWorkspace) || (b.updatedAt || 0) - (a.updatedAt || 0))
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block?.type === 'text' || block?.type === 'input_text') return block.text ?? ''
      return ''
    })
    .filter(Boolean)
    .join(' ')
}

function oneLine(text) {
  const line = String(text).replace(/\s+/g, ' ').trim()
  return (line.length > 120 ? line.slice(0, 120) : line) || 'Untitled session'
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const norm = (value) => value.replace(/[\\/]+$/, '') || value
  return norm(left) === norm(right)
}
