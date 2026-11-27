import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveCommand } from './process.js'

const run = promisify(execFile)
const LIST_TIMEOUT_MS = 60 * 1000

async function stdoutOf(bin, args) {
  const [command, ...prefix] = resolveCommand(bin)
  const { stdout } = await run(command, [...prefix, ...args], { timeout: LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' }, windowsHide: true })
  return stdout
}

function signInRequired(message) {
  const error = new Error(message)
  error.authRequired = true
  return error
}

const EFFORT_NAMES = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}

export function effortName(id) {
  return EFFORT_NAMES[id] ?? id
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_LUNA_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const CLAUDE_MODELS = [
  { id: 'default', name: 'Claude Code default', description: 'Use the model Claude Code is configured for' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'opus', name: 'Opus' },
  { id: 'haiku', name: 'Haiku' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4-1', name: 'Claude Opus 4.1' },
].map((model) => ({ ...model, efforts: EFFORTS, defaultEffort: 'high' }))

const CODEX_MODELS = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', context: 500000 },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', context: 272000 },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', context: 272000 },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', context: 272000, efforts: CODEX_LUNA_EFFORTS },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', context: 272000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', context: 272000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', context: 272000, efforts: CODEX_LUNA_EFFORTS },
].map((model) => ({ ...model, efforts: model.efforts ?? EFFORTS, defaultEffort: 'high' }))

const AGY_EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/i

/**
 * A suffixed `agy models` id already encodes its effort; expose only that one.
 * An unsuffixed id (the Orchestrator family) takes no `--effort` at all, so it
 * offers none.
 */
function agyModelEffort(model) {
  const suffix = AGY_EFFORT_SUFFIX.exec(model.id)
  return suffix
    ? { ...model, efforts: [suffix[1].toLowerCase()], defaultEffort: suffix[1].toLowerCase() }
    : { ...model, efforts: [] }
}

/** Antigravity's account-aware list, used when `agy models` cannot answer. */
const AGY_MODELS = [
  { id: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
  { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
  { id: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
  { id: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
  { id: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
  { id: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
  { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
  { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
].map(agyModelEffort)

/** CodeBuddy's account-aware aliases plus the model ids its `--help` lists. */
const CODEBUDDY_MODELS = [
  { id: 'default-model', name: 'CodeBuddy default' },
  { id: 'fast-model', name: 'CodeBuddy fast' },
  { id: 'balanced-model', name: 'CodeBuddy balanced' },
  { id: 'primary-model', name: 'CodeBuddy primary' },
  { id: 'deep-model', name: 'CodeBuddy deep' },
  { id: 'hy4-preview', name: 'Hunyuan 4 Preview' },
  { id: 'hy3', name: 'Hunyuan 3' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' },
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'kimi-k3', name: 'Kimi K3' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6' },
  { id: 'kimi-k2.8-preview', name: 'Kimi K2.8 Preview' },
].map((model) => ({ ...model, efforts: EFFORTS, defaultEffort: 'high' }))

function parseCodexCache(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!Array.isArray(data?.models)) return undefined
  const models = data.models
    .filter((model) => typeof model?.slug === 'string' && model.visibility === 'list')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((model) => ({
      id: model.slug,
      name: model.display_name || model.slug,
      ...(model.description ? { description: model.description } : {}),
      efforts: (model.supported_reasoning_levels ?? [])
        .map((level) => (typeof level === 'string' ? level : level?.effort))
        .filter((level) => typeof level === 'string'),
      defaultEffort: model.default_reasoning_level,
      context: model.context_window,
    }))
  return models.length > 0 ? models : undefined
}

async function codexModels(bin, extra) {
  try {
    await run(bin, [...extra, 'login', 'status'], { timeout: LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' }, windowsHide: true })
  } catch (error) {
    if (error?.code === 'ENOENT') throw error
    throw signInRequired('Codex is not signed in: run `codex login` in a terminal on the DSH machine')
  }
  try {
    return parseCodexCache(await readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'utf8')) ?? CODEX_MODELS
  } catch {
    return CODEX_MODELS
  }
}

/** `agy models` prints `<slug><whitespace><display name>` per model after a progress line. */
export function parseAgyModels(text) {
  const models = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\u200b-\u200d\ufeff]/g, '').trim()
    if (!line) continue
    const match = /^([a-z0-9][\w.:-]*)\s+(.+)$/i.exec(line)
    if (!match) continue
    const [, id, name] = match
    if (/^(fetching|loading|models?|available|error|warning)\b/i.test(id)) continue
    models.push({ id, name: name.trim() })
  }
  return models.map(agyModelEffort)
}

async function agyModels(bin, extra) {
  try {
    const text = await stdoutOf(bin, [...extra, 'models'])
    const models = parseAgyModels(text)
    return models.length > 0 ? models : AGY_MODELS
  } catch (error) {
    if (error?.code === 'ENOENT') throw error
    if (/authentication required|not signed in|login/i.test(String(error?.stderr ?? error?.message ?? ''))) {
      throw signInRequired('Antigravity is not signed in: run `agy acp --login` (or `agy` once) in a terminal on the DSH machine')
    }
    return AGY_MODELS
  }
}

const CLAUDE_DESCRIPTION = 'Hand every turn to Claude Code on this machine, with its own models, tools and sign-in. DSH shows and records the session.'
const CODEX_DESCRIPTION = 'Hand every turn to Codex on this machine, with its own models, tools and sign-in. DSH shows and records the session.'
const AGY_DESCRIPTION = 'Hand every turn to the Antigravity CLI on this machine, with its own models, tools and sign-in. DSH shows and records the session.'
const CODEBUDDY_DESCRIPTION = 'Hand every turn to CodeBuddy on this machine, with its own models, tools and sign-in. DSH shows and records the session.'

export const BACKENDS = {
  'claude-code': {
    label: 'Claude Code',
    order: 21,
    description: CLAUDE_DESCRIPTION,
    argv: () => ['claude-agent-acp'],
    login: 'claude auth login',
    print: {
      only: true,
      bin: 'claude',
      dialect: 'claude',
      stdin: 'json',
      models: async (bin) => {
        await stdoutOf(bin, ['--version'])
        return CLAUDE_MODELS
      },
      default: 'default',
      argv: (bin, extra, { model, resume, force }) => [
        bin,
        ...extra,
        '-p',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode',
        force ? 'bypassPermissions' : 'default',
        '--disallowedTools',
        'AskUserQuestion',
        ...(model && model !== 'default' ? ['--model', model] : []),
        ...(resume ? ['--resume', resume] : []),
      ],
    },
  },
  codex: {
    label: 'Codex',
    order: 22,
    description: CODEX_DESCRIPTION,
    argv: () => ['codex'],
    login: 'codex login',
    print: {
      only: true,
      bin: 'codex',
      dialect: 'codex',
      stdin: 'none',
      models: codexModels,
      env: ({ OPENAI_API_KEY: _openai, CODEX_API_KEY: _codex, ACP_CODEX_API_KEY: _acp, ...rest }) => rest,
      argv: (bin, extra, { model, effort, resume, force, prompt }) => [
        bin,
        ...extra,
        'exec',
        ...(resume ? ['resume', resume] : []),
        '--json',
        '--skip-git-repo-check',
        ...(model ? ['--model', model] : []),
        ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
        ...(force ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
        '--',
        prompt,
      ],
    },
  },
  codebuddy: {
    label: 'CodeBuddy',
    order: 24,
    description: CODEBUDDY_DESCRIPTION,
    argv: () => ['codebuddy'],
    login: 'codebuddy',
    print: {
      only: true,
      bin: 'codebuddy',
      dialect: 'claude',
      stdin: 'none',
      models: async (bin) => {
        await stdoutOf(bin, ['--version'])
        return CODEBUDDY_MODELS
      },
      default: 'default-model',
      argv: (bin, extra, { model, effort, resume, force, prompt }) => [
        bin,
        ...extra,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--effort', effort] : []),
        ...(resume ? ['--resume', resume] : []),
        ...(force ? ['--dangerously-skip-permissions'] : []),
        '--disallowedTools',
        'AskUserQuestion',
        prompt,
      ],
    },
  },
  antigravity: {
    label: 'Antigravity',
    order: 23,
    description: AGY_DESCRIPTION,
    argv: () => ['agy'],
    login: 'agy acp --login',
    print: {
      only: true,
      bin: 'agy',
      dialect: 'antigravity',
      stdin: 'none',
      models: agyModels,
      default: 'gemini-3.8-flash-high',
      argv: (bin, extra, { model, effort, resume, force, prompt, addDirs }) => {
        const suffix = model ? AGY_EFFORT_SUFFIX.exec(model) : null
        // A model id such as gemini-4-neon-high already encodes effort; pairing it
        // with --effort is rejected by agy. Strip the suffix and let the explicit
        // effort win, or keep the suffixed id when no effort is set. An unsuffixed
        // id (the Orchestrator family) rejects --effort outright, so drop it.
        const argvModel = suffix && effort ? model.slice(0, suffix.index) : model
        const argvEffort = !model || suffix ? effort : undefined
        return [
          bin,
          ...extra,
          '--output-format',
          'stream-json',
          ...(argvModel ? ['--model', argvModel] : []),
          ...(argvEffort ? ['--effort', argvEffort] : []),
          ...(addDirs?.length ? ['--add-dir', ...addDirs] : []),
          ...(resume ? ['--conversation', resume] : []),
          ...(force ? ['--dangerously-skip-permissions'] : []),
          '-p',
          prompt,
        ]
      },
    },
  },
}

/**
 * Slash commands forwarded to each CLI. Only commands that are known to run in
 * that CLI's headless/print mode are listed: a TUI-only command sent as a
 * prompt is just text, so it is better left out and reached through /agent.
 *
 * - claude-code: verified against Claude Code 2.1.329 (`local_command` in the
 *   JSON result). /status, /skills, /permissions and /help answer "isn't
 *   available in this environment", so they are not registered.
 * - codex: `codex exec` has no slash-command layer; only /agent forwarding.
 * - antigravity: verified against agy 1.5.18 `agy -p /help`; /status and
 *   /context are not print-mode commands, so they are not registered.
 * - codebuddy: command names read from the print-mode `init` event; execution
 *   is not verified.
 */
export const COMMAND_SUPPORT = {
  'claude-code': {
    native: ['usage', 'context', 'cost', 'config'],
    compact: true,
    source: 'verified',
  },
  codex: {
    native: [],
    compact: false,
    source: 'codex exec has no slash-command layer',
  },
  antigravity: {
    native: ['agents', 'changelog', 'config', 'credits', 'effort', 'hooks', 'permissions', 'plugin', 'skills', 'usage'],
    compact: true,
    source: 'verified against agy 1.5.18 print mode',
  },
  codebuddy: {
    native: ['config', 'context', 'cost', 'skills', 'status', 'permissions', 'effort', 'review', 'init', 'agents', 'doctor', 'stats'],
    compact: true,
    source: 'read from the CLI init slash_commands; execution not verified',
  },
}

/** Commands DSH itself owns; a backend cannot shadow them. */
export const RESERVED_COMMANDS = new Set(['resume', 'agent', 'model', 'plan', 'codex-plan', 'compact', 'goal', 'clear', 'help'])

/** Registered native command names for a backend, never shadowing DSH. */
export function nativeCommands(backendId) {
  return (COMMAND_SUPPORT[backendId]?.native ?? []).filter((name) => !RESERVED_COMMANDS.has(name))
}

export function isAuthError(error) {
  return error?.authRequired === true || error?.acp?.code === -32000 || /authentication required/i.test(String(error?.message ?? ''))
}

export function isMissingCommand(error) {
  return error?.code === 'ENOENT'
}

/** Split a launch line into argv, honouring quotes and backslash escapes. */
export function parseCommand(line) {
  const argv = []
  let current = ''
  let quote
  let pushed = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === quote) quote = undefined
      else if (char === '\\' && quote === '"' && index + 1 < line.length) current += line[++index]
      else current += char
      pushed = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      pushed = true
      continue
    }
    if (char === '\\' && index + 1 < line.length && /[\s"'\\]/.test(line[index + 1])) {
      current += line[++index]
      pushed = true
      continue
    }
    if (/\s/.test(char)) {
      if (pushed) {
        argv.push(current)
        current = ''
        pushed = false
      }
      continue
    }
    current += char
    pushed = true
  }
  if (quote) throw new Error(`unclosed ${quote} in command: ${line}`)
  if (pushed) argv.push(current)
  return argv
}

/** Merge a saved launch line into a backend definition. */
export function resolveBackend(id, override = {}) {
  const base = BACKENDS[id]
  if (!base) throw new Error(`unknown backend: ${id}`)
  const model = override.model?.trim() || undefined
  const custom = override.command?.trim() ? parseCommand(override.command) : undefined
  const print = base.print
  const sameCommand = custom && print?.only && basename(custom[0]) === basename(base.argv()[0])
  const bin = (sameCommand ? undefined : custom?.[0]) ?? print?.bin ?? base.argv()[0]
  const extra = (sameCommand ? [] : (custom?.slice(1) ?? [])).filter((arg) => arg !== 'acp' && arg !== '--acp')
  const resolved = {
    id,
    label: base.label,
    order: base.order,
    description: base.description,
    login: base.login,
    model,
    argv: print?.only ? [bin, ...extra] : (custom ?? base.argv(model)),
  }
  if (print) {
    resolved.dialect = print.dialect
    resolved.stdin = print.stdin
    resolved.inputIncludesCache = print.inputIncludesCache === true
    resolved.defaultModel = model ?? print.default
    resolved.listModels = () => print.models(bin, extra)
    resolved.printEnv = print.env ?? ((env) => env)
    resolved.printArgv = (options) => print.argv(bin, extra, options)
    if (!print.only) resolved.acpArgv = () => [...(custom ?? base.argv(model)), 'acp']
  }
  return resolved
}

export function parseModelList(text) {
  const models = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\u200b-\u200d\ufeff]/g, '').trim()
    if (!line) continue
    const match = /^(\S+)(?:\s+-\s+(.+?))?(?:\s+\((?:default|current)\))?$/.exec(line)
    if (!match) continue
    models.push({ id: match[1], name: (match[2] ?? match[1]).trim() })
  }
  return models
}

const launchSources = new Map()

/** Let a plugin row supply the launch line, model and permission its backend starts with. */
export function provideLaunch(id, read) {
  launchSources.set(id, read)
  return () => {
    if (launchSources.get(id) === read) launchSources.delete(id)
  }
}

export function currentBackend(id) {
  const launch = launchSources.get(id)?.() ?? {}
  const backend = resolveBackend(id, launch)
  backend.permission = launch.permission === 'deny' ? 'deny' : 'allow'
  return backend
}

/** Approval prompts are auto-approved only when the user allowed it; root can never skip them. */
export function printForce(backend, uid = process.getuid?.()) {
  if (backend.permission !== 'allow') return false
  if ((backend.id === 'claude-code' || backend.id === 'codebuddy') && uid === 0) return false
  return true
}
