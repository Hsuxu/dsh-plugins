import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatClaudeUsage, formatCodexRateLimits, queryQuota, QUOTA_SUPPORT } from '../lib/quota.js'

test('subscription quota is exposed only for Codex and Claude Code', () => {
  assert.equal(QUOTA_SUPPORT['claude-code'], true)
  assert.equal(QUOTA_SUPPORT.codex, true)
  assert.equal(QUOTA_SUPPORT.antigravity, undefined)
  assert.equal(QUOTA_SUPPORT.codebuddy, undefined)
})

test('formatClaudeUsage reads both documented payload shapes', () => {
  const top = formatClaudeUsage({
    five_hour: { utilization: 0.275, resets_at: '2026-11-23T17:00:00Z' },
    seven_day: { utilization: 44, resets_at: '2026-11-30T09:00:00Z' },
  })
  assert.match(top.text, /5-hour window: 27\.5% used/)
  assert.match(top.text, /Weekly window: 44% used/)
  assert.equal(top.windows.length, 2)

  const listed = formatClaudeUsage({
    limits: [
      { kind: 'session', percent: 12.5, resets_at: '2026-11-23T17:00:00Z' },
      { kind: 'weekly', percent: 60, resets_at: '2026-11-30T09:00:00Z' },
    ],
  })
  assert.match(listed.text, /session: 12\.5% used/)
  assert.match(listed.text, /weekly: 60% used/)

  const withTokens = formatClaudeUsage(
    { five_hour: { utilization: 10, resets_at: '2026-11-23T17:00:00Z' } },
    { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000, cacheWriteTokens: 600 },
  )
  assert.match(withTokens.text, /Tokens: 1\.2K input · 340 output · 5\.0K cache read · 600 cache write/)
})

test('formatCodexRateLimits accepts nested and flat snapshots', () => {
  const nested = formatCodexRateLimits(
    {
      rateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_795_000_000 },
        secondary: { usedPercent: 71, windowDurationMins: 10_080, resetsAt: 1_795_500_000 },
      },
    },
    { account: { planType: 'pro' } },
  )
  assert.equal(nested.plan, 'pro')
  assert.equal(nested.windows.length, 2)
  assert.match(nested.text, /Plan: pro/)
  assert.match(nested.text, /5-hour window: 42% used/)
  assert.match(nested.text, /Weekly window: 71% used/)

  const flat = formatCodexRateLimits({
    primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: 1_795_000_000 },
    planType: 'plus',
  })
  assert.match(flat.text, /Plan: plus/)
  assert.match(flat.text, /1-hour window: 5% used/)

  const today = new Date().toLocaleDateString('en-CA')
  const withUsage = formatCodexRateLimits(
    { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1_795_000_000 } },
    { account: { planType: 'plus' } },
    {
      summary: {
        lifetimeTokens: 5_232_392_021,
        peakDailyTokens: 224_399_065,
        currentStreakDays: 7,
        longestStreakDays: 12,
      },
      dailyUsageBuckets: [
        { startDate: '2026-01-01', tokens: 1_000 },
        { startDate: today, tokens: 198_029_400 },
      ],
    },
  )
  assert.match(withUsage.text, /Tokens: 5\.23B lifetime · 198\.03M today/)
  assert.match(withUsage.text, /Usage: peak 224\.40M\/day · 7d streak \(longest 12d\)/)
  assert.match(withUsage.text, /Cache: not reported by Codex app-server/)
})

test('an unsupported backend returns a handled error', async () => {
  const result = await queryQuota('antigravity')
  assert.equal(result.ok, false)
  assert.match(result.error, /does not expose subscription quota/)
})
