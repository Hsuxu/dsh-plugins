/**
 * Host half of dsh-sidebar-session-status.
 *
 * Registers one Session projection that folds `turn/end` into the last turn
 * outcome, so the Client can style failed Sessions. Everything visible lives in
 * `lib/client.js`; this file only owns log-derived state.
 */

import { projectionDefinition } from './projection.js'

/** Bundle row name (must match `package.json`). */
export const name = 'dsh-sidebar-session-status'

/** Wait for the projection registry before applying. */
export const inject = ['sessionProjections']

/**
 * Register the projection unit. Registration is owned by this plugin fiber, so
 * unloading the bundle releases the unit automatically.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @returns {Promise<void>} Resolves once the unit is registered.
 */
export async function apply(ctx) {
  await ctx.sessionProjections.register(projectionDefinition)
}
