/**
 * Fold `codex app-server` notifications from a Plan-mode turn into the final
 * plan text. Plan items are authoritative; streamed deltas are only a fallback
 * for older servers that do not emit a completed plan item.
 */
export class CodexPlanStream {
  constructor() {
    this.plan = ''
    this.message = ''
    this.completed = false
    this.turn = null
    this.usage = null
    this.error = null
    this.done = new Promise((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
  }

  #resolve
  #reject

  text() {
    return (this.plan || this.message || '').trim()
  }

  failure() {
    if (this.error) return this.error
    if (this.turn?.status && this.turn.status !== 'completed') {
      return this.turn.error?.message ?? `Codex plan turn ${this.turn.status}`
    }
    return undefined
  }

  push(method, params = {}) {
    switch (method) {
      case 'item/plan/delta':
        this.plan += String(params.delta ?? '')
        break
      case 'item/agentMessage/delta':
        this.message += String(params.delta ?? '')
        break
      case 'item/completed': {
        const item = params.item ?? {}
        if (item.type === 'plan' && typeof item.text === 'string') this.plan = item.text
        else if (item.type === 'agentMessage' && typeof item.text === 'string') this.message = item.text
        break
      }
      case 'turn/plan/updated': {
        if (!this.plan && Array.isArray(params.plan)) {
          this.plan = params.plan.map((step) => `- [${step.status ?? 'pending'}] ${step.step ?? ''}`).join('\n')
        }
        break
      }
      case 'thread/tokenUsage/updated':
        this.usage = params.tokenUsage?.total ?? this.usage
        break
      case 'turn/completed':
        this.turn = params.turn ?? null
        this.completed = true
        this.#resolve(this.turn)
        break
      case 'error':
        this.error = String(params.message ?? params.error?.message ?? 'Codex app-server error')
        this.#reject(new Error(this.error))
        break
      default:
        break
    }
  }
}
