import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { effortName, isAuthError, isMissingCommand } from './backends.js'
import { providerId } from './models.js'

const FRESH_MS = 10 * 60 * 1000
const FAILED_MS = 10 * 1000

/** First model of each backend's latest listing, which the picker shows as a fresh session's current model. */
const firstListed = new Map()

/** @returns the first model the backend last listed, or undefined before any listing. */
export function firstListedModel(backendId) {
  return firstListed.get(backendId)
}

/**
 * @returns the backend's models, each with `id`, `name` and optionally
 *   `description`, `context` and `reasoning` in DSH's shape.
 */
async function discover(backend) {
  const models = (await backend.listModels()).map(({ efforts, defaultEffort, ...model }) => ({
    ...model,
    ...(efforts?.length > 0 && { reasoning: { efforts: efforts.map((id) => ({ id, name: effortName(id) })), ...(defaultEffort && { defaultEffort }) } }),
  }))
  return defaultFirst({ models }, backend.defaultModel)
}

/**
 * The model a turn runs when its session picked none of this agent's models goes
 * first: the browser shows it as the current model of such a session.
 * @param preferred - the row's default model, used when the CLI lists it.
 */
export function defaultFirst({ models, current }, preferred) {
  const id = models.some((m) => m.id === preferred) ? preferred : current
  const at = models.findIndex((m) => m.id === id)
  return at <= 0 ? models : [models[at], ...models.slice(0, at), ...models.slice(at + 1)]
}

/** Why an agent CLI cannot list models yet, or undefined for a real failure. */
function notReady(error, backend) {
  if (isAuthError(error)) return `not signed in; run \`${backend.login}\``
  if (isMissingCommand(error)) return `\`${backend.argv[0]}\` is not on PATH`
}

/**
 * Lists one external agent's models in the native model picker. The route is a
 * catalog only: turns of a cli preset never reach `stream()`, because the
 * preset's driver answers every step itself.
 */
class CliCatalogAdapter extends LlmAdapter {
  /** @param current - returns the backend as currently configured. */
  constructor(current) {
    super()
    this.current = current
    this.cache = undefined
    this.reported = undefined
  }

  providerInfo(provider) {
    return { id: provider, name: this.current().label }
  }

  /** @returns the cached listing with each model's reasoning and context metadata. */
  listing() {
    const backend = this.current()
    const key = JSON.stringify([backend.argv, backend.model])
    if (this.cache?.key === key && Date.now() < this.cache.until) return this.cache.models
    const models = discover(backend).then(
      (list) => {
        this.reported = undefined
        if (list[0]) firstListed.set(backend.id, list[0].id)
        return list
      },
      (error) => {
        if (this.cache?.models === models) this.cache.until = Date.now() + FAILED_MS
        const reason = notReady(error, backend)
        if (reason === undefined) throw error
        if (this.reported !== reason) console.warn(`[dsh-cli-bridge] ${backend.label} models hidden: ${reason}`)
        this.reported = reason
        return []
      },
    )
    this.cache = { key, models, until: Date.now() + FRESH_MS }
    return models
  }

  /**
   * An agent that is not signed in or not installed lists no models, which hides
   * its route from the selector like a provider without credentials; a later
   * discovery picks it up once the user signs in.
   */
  async listModels(provider) {
    return (await this.listing()).map(({ id, name, description }) => ({ provider, id, name, ...(description && { description }) }))
  }

  /** Reasoning efforts and context window of one listed model, for the picker's effort menu. */
  async resolveModel(provider, model) {
    const found = (await this.listing().catch(() => [])).find((m) => m.id === model)
    if (!found) return { provider, id: model, name: model }
    return {
      provider,
      id: model,
      name: found.name,
      ...(found.description && { description: found.description }),
      ...(found.context && { context: { contextWindow: found.context } }),
      ...(found.reasoning && { reasoning: found.reasoning }),
    }
  }

  async *stream() {
    const { label } = this.current()
    throw new Error(`${label} models run only in the ${label} agent preset; choose it from the mode menu or pick another model`)
  }
}

/**
 * @param current - returns the backend as currently configured; a changed launch
 *   command or default model invalidates the cached list.
 */
export function registerCatalog(ctx, current) {
  const provider = providerId(current().id)
  const adapter = new CliCatalogAdapter(current)
  ctx.llm.registerAdapter([provider], adapter)
  adapter.listModels(provider).catch(() => {})
}
