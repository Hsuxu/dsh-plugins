/**
 * Codex Plan mode state, persisted as a plugin record and replayed into the
 * `cliPlan` session projection. The plan text is streamed into the transcript
 * by the driver and reviewed through the native DSH plan-review popup.
 */
export const PLAN_EVENT = 'plugin:dsh-cli-bridge/plan'
export const PLAN_PROJECTION_KEY = 'cliPlan'
export const PLAN_TEXT_LIMIT = 64 * 1024

/** Normalize a plan record; `null` hides the dock. */
export function planView(data) {
  if (!data || typeof data !== 'object') return null
  const active = data.active === true
  const pending = data.pending === true
  const reviewPending = data.reviewPending === true
  if (!active && !pending && !reviewPending) return null
  return {
    active,
    pending,
    reviewPending,
    threadId: typeof data.threadId === 'string' ? data.threadId : null,
    plan: typeof data.plan === 'string' ? data.plan.slice(0, PLAN_TEXT_LIMIT) : '',
    requestId: typeof data.requestId === 'string' ? data.requestId : null,
    updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : Date.now(),
    approved: data.approved === true,
    error: typeof data.error === 'string' ? data.error : null,
  }
}

/** Latest raw plan record written by the driver, if any. */
export function latestPlanEvent(session) {
  let latest
  for (const event of session?.snapshotEvents?.() ?? []) {
    if (event.type === PLAN_EVENT && event.data && typeof event.data === 'object') latest = event.data
  }
  return latest
}
