import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { currentBackend } from './backends.js'
import { spawnAgent, stopAgent } from './process.js'

const run = promisify(execFile)
const WINDOWS = process.platform === 'win32'
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_USAGE_BETA = 'oauth-2025-04-20'
const FRESH_MS = 30 * 1000
const FAILED_MS = 10 * 1000
const CAPTURE_TIMEOUT_MS = 15 * 1000

/** Backends that can report subscription quota. */
export const QUOTA_SUPPORT = {
  'claude-code': true,
  codex: true,
  antigravity: true,
}

const cache = new Map()

function fresh(entry, ttl) {
  return entry && Date.now() - entry.at < ttl ? entry.result : undefined
}

function remember(backendId, result) {
  cache.set(backendId, { at: Date.now(), result })
  return result
}

function failure(backendId, error) {
  return { ok: false, backend: backendId, error }
}

/**
 * Query subscription quota for one backend. Never throws for an expected
 * failure (not signed in, CLI missing, custom Claude endpoint, timeout); the
 * caller renders `error` and keeps the session usable.
 */
export async function queryQuota(backendId, options = {}) {
  const cached = options.refresh ? undefined : fresh(cache.get(backendId), FRESH_MS)
  if (cached) return cached
  const failed = options.refresh ? undefined : fresh(cache.get(backendId), FAILED_MS)
  if (failed && !failed.ok) return failed

  let backend
  try {
    backend = options.backend ?? currentBackend(backendId)
  } catch (error) {
    return failure(backendId, error instanceof Error ? error.message : String(error))
  }

  try {
    if (backendId === 'claude-code') return remember(backendId, await claudeQuota(backend, options))
    if (backendId === 'codex') return remember(backendId, await codexQuota(backend, options))
    if (backendId === 'antigravity') return remember(backendId, await antigravityQuota(backend, options))
    return remember(backendId, failure(backendId, `${backend.label} does not expose subscription quota.`))
  } catch (error) {
    return remember(backendId, failure(backendId, redactError(error)))
  }
}

function redactError(error) {
  return String(error instanceof Error ? error.message : error).replace(
    /(token|secret|password|authorization)\s*[:=]\s*\S+/gi,
    '$1=[redacted]',
  )
}

async function claudeQuota(backend, options) {
  const env = claudeEnv()
  const base = String(env.ANTHROPIC_BASE_URL ?? '').trim()
  if (base && !/^https:\/\/api\.anthropic\.com\/?$/i.test(base)) {
    const local = await claudeLocalUsage(backend, options)
    const lines = [
      'Claude Code is using a custom ANTHROPIC_BASE_URL, so subscription quota is not available.',
      'Remove ANTHROPIC_BASE_URL and sign in with `claude auth login` to use subscription quota.',
    ]
    const localText = formatLocalUsage(local)
    if (localText) lines.push(localText)
    return { ok: true, backend: 'claude-code', text: lines.join('\n') }
  }

  const token = await claudeToken(backend, options)
  if (!token) {
    return failure(
      'claude-code',
      'Claude Code is not signed in with an OAuth account. Run `claude auth login` in a terminal, then try again.',
    )
  }

  let response
  try {
    response = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': CLAUDE_USAGE_BETA,
        'user-agent': 'dsh-cli-bridge/0.1.0',
      },
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    })
  } catch (error) {
    return failure('claude-code', `Could not reach Anthropic usage service: ${redactError(error)}`)
  }
  if (response.status === 401 || response.status === 403) {
    return failure('claude-code', 'Claude Code OAuth credentials were rejected. Run `claude auth login` again.')
  }
  if (!response.ok) {
    return failure('claude-code', `Anthropic usage service returned HTTP ${response.status}.`)
  }
  const payload = await response.json().catch(() => undefined)
  if (!payload || typeof payload !== 'object') {
    return failure('claude-code', 'Anthropic usage service returned an unexpected response.')
  }
  const local = await claudeLocalUsage(backend, options)
  return { ok: true, backend: 'claude-code', ...formatClaudeUsage(payload, local) }
}

async function claudeLocalUsage(backend, options) {
  if (options.localUsage === false) return undefined
  let stdout = ''
  let stderr = ''
  let child
  try {
    child = spawnAgent(
      [...backend.argv, '-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' }, windowsHide: true },
    )
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-64 * 1024)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096)
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void stopAgent(child).catch(() => {})
        reject(new Error(`Claude /usage did not answer within ${CAPTURE_TIMEOUT_MS / 1000}s.`))
      }, CAPTURE_TIMEOUT_MS)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(stderr.trim() || `claude exited with code ${code}`))
      })
    })
  } catch {
    return undefined
  }
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1)
  if (!line) return undefined
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  const usage = parsed?.usage
  if (!usage || typeof usage !== 'object') return undefined
  return {
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
    cacheReadTokens: number(usage.cache_read_input_tokens),
    cacheWriteTokens: number(usage.cache_creation_input_tokens),
    costUsd: number(parsed.total_cost_usd),
  }
}

function claudeEnv() {
  const settings = join(homedir(), '.claude', 'settings.json')
  let fileEnv = {}
  try {
    const parsed = JSON.parse(readFileSync(settings, 'utf8'))
    if (parsed && typeof parsed.env === 'object' && parsed.env) fileEnv = parsed.env
  } catch {
    // Claude may not be installed, or may not use settings.json.
  }
  return { ...fileEnv, ...process.env }
}

async function claudeToken(backend, options) {
  const env = claudeEnv()
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return String(env.CLAUDE_CODE_OAUTH_TOKEN).trim()

  for (const path of [
    join(homedir(), '.claude', '.credentials.json'),
    join(env.APPDATA ?? '', '.claude', '.credentials.json'),
    join(env.APPDATA ?? '', 'claude', '.credentials.json'),
  ]) {
    if (!path || path.startsWith('.claude')) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const token =
        parsed?.claudeAiOauth?.accessToken ??
        parsed?.accessToken ??
        parsed?.oauth?.accessToken ??
        parsed?.oauth?.access_token
      if (token) return String(token).trim()
    } catch {
      // Try the next storage location.
    }
  }

  if (WINDOWS) {
    const blob = await windowsCredential('Claude Code-credentials')
    if (blob) {
      try {
        const parsed = JSON.parse(blob)
        const token = parsed?.claudeAiOauth?.accessToken ?? parsed?.accessToken ?? parsed?.oauth?.accessToken
        if (token) return String(token).trim()
      } catch {
        // Some versions store a bare token.
        if (!blob.startsWith('{')) return blob.trim()
      }
    }
  }
  return undefined
}

/**
 * Read a generic Windows credential without adding a dependency. This is only
 * used for the Claude OAuth blob; failures are silent and fall through to the
 * user-facing "not signed in" message.
 */
async function windowsCredential(target) {
  const script = `
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
public class DshCredReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize;
    public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr buffer);
  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) return null;
    var credential = Marshal.PtrToStructure<CREDENTIAL>(pointer);
    var value = Marshal.PtrToStringUni(credential.CredentialBlob, credential.CredentialBlobSize / 2);
    CredFree(pointer);
    return value;
  }
}
'@
Add-Type -TypeDefinition $source
$value = [DshCredReader]::Read('${target.replace(/'/g, "''")}')
if ($value) { [Console]::Out.Write($value) }
`
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

async function codexQuota(backend) {
  const child = spawnAgent([...backend.argv, 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  })

  let settled = false
  let account
  let limits
  let usage
  let limitsDone = false
  let usageDone = false
  let usageTimer
  let stderr = ''
  let buffer = ''

  return await new Promise((resolve) => {
    const maybeFinish = () => {
      if (!limitsDone || !usageDone) return
      const formatted = formatCodexRateLimits(limits, account, usage)
      finish({ ok: true, backend: 'codex', ...formatted })
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(usageTimer)
      child.stdout?.removeAllListeners()
      child.stderr?.removeAllListeners()
      child.removeAllListeners()
      child.stdin?.destroy()
      void stopAgent(child).catch(() => {})
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish(
        failure(
          'codex',
          `Codex app-server did not answer within ${CAPTURE_TIMEOUT_MS / 1000}s.${stderr ? ` ${stderr.slice(-400)}` : ''}`,
        ),
      )
    }, CAPTURE_TIMEOUT_MS)

    const send = (message) => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`)
      } catch (error) {
        finish(failure('codex', `Could not write to Codex app-server: ${redactError(error)}`))
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.error) {
          if (message.id === 4) {
            usageDone = true
            clearTimeout(usageTimer)
            maybeFinish()
          } else {
            finish(failure('codex', `Codex app-server: ${message.error.message ?? JSON.stringify(message.error)}`))
          }
          return
        }
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          send({ jsonrpc: '2.0', id: 2, method: 'account/read', params: {} })
          send({ jsonrpc: '2.0', id: 3, method: 'account/rateLimits/read', params: {} })
          send({ jsonrpc: '2.0', id: 4, method: 'account/usage/read', params: {} })
          continue
        }
        if (message.id === 2) {
          account = message.result
          continue
        }
        if (message.id === 3) {
          limits = message.result
          limitsDone = true
          usageTimer = setTimeout(() => {
            usageDone = true
            maybeFinish()
          }, 1_500)
          maybeFinish()
          continue
        }
        if (message.id === 4) {
          usage = message.result
          usageDone = true
          clearTimeout(usageTimer)
          maybeFinish()
        }
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096)
    })
    child.on('error', (error) => {
      finish(failure('codex', `Could not start Codex app-server: ${redactError(error)}`))
    })
    child.on('close', (code) => {
      if (!settled) {
        finish(
          failure(
            'codex',
            `Codex app-server exited with code ${code}.${stderr ? ` ${stderr.trim().slice(-600)}` : ''}`,
          ),
        )
      }
    })

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'dsh-cli-bridge', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    })
  })
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function percent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.round((value > 0 && value <= 1 ? value * 100 : value) * 10) / 10
}

function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function isoOrEpoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const time = Date.parse(value)
    if (Number.isFinite(time)) return time / 1000
  }
  return undefined
}

function formatReset(resetsAt) {
  const seconds = isoOrEpoch(resetsAt)
  if (seconds === undefined) return undefined
  try {
    return new Date(seconds * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return undefined
  }
}

function windowLabel(minutes, fallback) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return fallback
  if (minutes === 10_080) return 'Weekly window'
  if (minutes === 300) return '5-hour window'
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`
  return `${Math.round(minutes)}-minute window`
}

/** `agy -p /usage --output-format json` prints a command payload. */
export function formatAntigravityUsage(payload) {
  const data = payload?.result?.command?.data ?? payload?.command?.data ?? payload?.data
  const groups = Array.isArray(data?.groups) ? data.groups : []
  const lines = []
  for (const group of groups) {
    const buckets = Array.isArray(group?.buckets) ? group.buckets : []
    const parts = []
    for (const bucket of buckets) {
      const label = bucket?.name || bucket?.window || bucket?.id || 'Quota'
      const fraction = Number(bucket?.remaining_fraction)
      const percent = Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : '?'
      const reset = typeof bucket?.reset_time === 'string' && bucket.reset_time !== '1970-01-01T00:00:00Z'
        ? ` (resets ${bucket.reset_time})`
        : ''
      parts.push(`${label}: ${percent} left${reset}`)
    }
    if (parts.length) lines.push(`${group?.name || 'Antigravity'}: ${parts.join(' · ')}`)
  }
  if (lines.length === 0 && typeof payload?.result?.response === 'string') lines.push(payload.result.response.trim())
  return lines.join('\n')
}

async function antigravityQuota(backend) {
  return new Promise((resolve, reject) => {
    const child = spawnAgent([...backend.argv, '-p', '/usage', '--output-format', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      void stopAgent(child, 3000)
      reject(new Error('agy /usage timed out'))
    }, CAPTURE_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `agy /usage exited with code ${code}`))
        return
      }
      try {
        resolve(formatAntigravityUsage(JSON.parse(stdout)))
      } catch (error) {
        reject(new Error(`could not parse agy /usage output: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }).then((text) => {
    if (!text) throw new Error('agy /usage returned no quota data')
    return { ok: true, backend: 'antigravity', text }
  })
}

export function formatCodexRateLimits(limits, account, usage) {
  const snapshot =
    limits?.rateLimits ??
    limits?.rateLimit ??
    limits?.result?.rateLimits ??
    limits?.result?.rateLimit ??
    limits ??
    {}
  const plan =
    account?.account?.planType ??
    account?.planType ??
    snapshot?.planType ??
    snapshot?.plan_type ??
    undefined
  const windows = []
  for (const [key, fallback] of [
    ['primary', '5-hour window'],
    ['secondary', 'Weekly window'],
  ]) {
    const entry = snapshot?.[key] ?? snapshot?.[`${key}Window`]
    if (!entry) continue
    const usedPercent = percent(entry.usedPercent ?? entry.used_percent ?? entry.percent)
    if (usedPercent === undefined) continue
    windows.push({
      label: windowLabel(number(entry.windowDurationMins ?? entry.window_duration_mins), fallback),
      usedPercent,
      resetsAt: isoOrEpoch(entry.resetsAt ?? entry.resets_at),
      windowMins: number(entry.windowDurationMins ?? entry.window_duration_mins),
    })
  }
  if (windows.length === 0 && Array.isArray(snapshot?.limits)) {
    for (const entry of snapshot.limits) {
      const usedPercent = percent(entry.percent ?? entry.usedPercent)
      if (usedPercent === undefined) continue
      windows.push({
        label: String(entry.kind ?? entry.label ?? 'Limit'),
        usedPercent,
        resetsAt: isoOrEpoch(entry.resetsAt ?? entry.resets_at),
      })
    }
  }
  const credits = snapshot?.credits ?? snapshot?.creditBalance
  const lines = []
  if (plan) lines.push(`Plan: ${plan}`)
  for (const window of windows) {
    const reset = formatReset(window.resetsAt)
    lines.push(`${window.label}: ${window.usedPercent}% used${reset ? ` (resets ${reset})` : ''}`)
  }
  if (credits !== undefined && credits !== null) {
    lines.push(`Credits: ${typeof credits === 'object' ? JSON.stringify(credits) : credits}`)
  }
  if (usage && typeof usage === 'object') {
    const summary = usage.summary && typeof usage.summary === 'object' ? usage.summary : {}
    const buckets = Array.isArray(usage.dailyUsageBuckets) ? usage.dailyUsageBuckets : []
    const today = new Date().toLocaleDateString('en-CA')
    const todayEntry = buckets.find((entry) => entry?.startDate === today) ?? buckets.at(-1)
    const todayTokens = number(todayEntry?.tokens)
    const todayLabel =
      todayEntry?.startDate === today
        ? 'today'
        : todayEntry?.startDate
          ? `latest ${todayEntry.startDate}`
          : undefined
    const lifetime = number(summary.lifetimeTokens)
    const parts = []
    if (lifetime !== undefined) parts.push(`${formatTokens(lifetime)} lifetime`)
    if (todayTokens !== undefined) parts.push(`${formatTokens(todayTokens)} ${todayLabel}`)
    if (parts.length > 0) lines.push(`Tokens: ${parts.join(' · ')}`)
    const peak = number(summary.peakDailyTokens)
    const currentStreak = number(summary.currentStreakDays)
    const longestStreak = number(summary.longestStreakDays)
    const extras = []
    if (peak !== undefined) extras.push(`peak ${formatTokens(peak)}/day`)
    if (currentStreak !== undefined) {
      extras.push(`${currentStreak}d streak${longestStreak !== undefined ? ` (longest ${longestStreak}d)` : ''}`)
    }
    if (extras.length > 0) lines.push(`Usage: ${extras.join(' · ')}`)
    lines.push('Cache: not reported by Codex app-server')
  }
  if (lines.length === 0) {
    const text = JSON.stringify(snapshot)
    lines.push(text && text !== '{}' ? `Codex usage: ${text.slice(0, 800)}` : 'Codex returned no usage windows.')
  }
  return { plan, windows, text: lines.join('\n') }
}

/** Format the Anthropic OAuth usage payload (`five_hour`/`seven_day` or `limits[]`). */
export function formatClaudeUsage(payload, localUsage) {
  const windows = []
  if (Array.isArray(payload.limits)) {
    for (const entry of payload.limits) {
      const usedPercent = percent(entry.percent ?? entry.utilization)
      if (usedPercent === undefined) continue
      windows.push({
        label: String(entry.kind ?? entry.label ?? 'Limit'),
        usedPercent,
        resetsAt: isoOrEpoch(entry.resetsAt ?? entry.resets_at),
      })
    }
  }
  for (const [key, label] of [
    ['five_hour', '5-hour window'],
    ['seven_day', 'Weekly window'],
    ['monthly', 'Monthly window'],
  ]) {
    const entry = payload[key]
    if (!entry || typeof entry !== 'object') continue
    const usedPercent = percent(entry.utilization ?? entry.usedPercent ?? entry.percent)
    if (usedPercent === undefined) continue
    if (windows.some((window) => window.label === label)) continue
    windows.push({
      label,
      usedPercent,
      resetsAt: isoOrEpoch(entry.resets_at ?? entry.resetsAt),
    })
  }
  const plan =
    payload.subscriptionType ?? payload.subscription_type ?? payload.plan ?? payload.planType ?? undefined
  const lines = []
  if (plan) lines.push(`Plan: ${plan}`)
  for (const window of windows) {
    const reset = formatReset(window.resetsAt)
    lines.push(`${window.label}: ${window.usedPercent}% used${reset ? ` (resets ${reset})` : ''}`)
  }
  if (lines.length === 0) lines.push('Claude returned no subscription windows.')
  const localText = formatLocalUsage(localUsage)
  if (localText) lines.push(localText)
  return { plan, windows, text: lines.join('\n') }
}

function formatLocalUsage(localUsage) {
  if (!localUsage) return undefined
  const parts = [
    localUsage.inputTokens !== undefined ? `${formatTokens(localUsage.inputTokens)} input` : undefined,
    localUsage.outputTokens !== undefined ? `${formatTokens(localUsage.outputTokens)} output` : undefined,
    localUsage.cacheReadTokens !== undefined
      ? `${formatTokens(localUsage.cacheReadTokens)} cache read`
      : undefined,
    localUsage.cacheWriteTokens !== undefined
      ? `${formatTokens(localUsage.cacheWriteTokens)} cache write`
      : undefined,
  ].filter(Boolean)
  return parts.length > 0 ? `Tokens: ${parts.join(' · ')}` : undefined
}

/** Test helper: clear the in-memory quota cache. */
export function resetQuotaCache() {
  cache.clear()
}
