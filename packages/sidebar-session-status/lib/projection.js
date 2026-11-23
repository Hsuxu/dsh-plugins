/**
 * Host-side Session projection that records how the last turn ended.
 *
 * The Client never receives per-turn failures in `SessionStatus`: it only knows
 * `running`, `pendingInteraction`, and `completionUnread`. A summary projection
 * is the one log-derived value a list row can read, so this unit folds
 * `turn/end` into `{ outcome, turn }` and lets the sidebar style failed Sessions.
 *
 * Runtime contract (dsh-session-projection): the registry only calls
 * `stateSchema.parse` / `viewSchema.parse` and compares successive `wire.view`
 * results with `Object.is`. The schemas below are dependency-free and return
 * the value they validate, so the view keeps its reference.
 */

/** Projection key; also the key the Client reads from `projectionValues`. */
export const PROJECTION_KEY = 'sidebarSessionStatus'

/** Turn outcome meaning "this Session has not ended a turn yet". */
export const NO_TURN_OUTCOME = 'none'

/**
 * @typedef {object} SessionOutcomeState
 * @property {string} outcome TurnEndReason kind of the last ended turn.
 * @property {number} turn 1-based turn number that ended, or -1 before any turn.
 */

/**
 * Build the minimal `{ parse }` schema the projection registry needs.
 * @param {string} label Schema name used in error messages.
 * @returns {{ parse(value: unknown): unknown }}
 */
function createStateSchema(label) {
  return {
    parse(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} must be a plain object`)
      }
      const { outcome, turn } = value
      if (typeof outcome !== 'string' || outcome === '') {
        throw new TypeError(`${label}.outcome must be a non-empty string`)
      }
      if (!Number.isInteger(turn) || turn < -1) {
        throw new TypeError(`${label}.turn must be an integer >= -1`)
      }
      return value
    },
  }
}

/** Internal state schema (parsed on restore from a checkpoint). */
export const stateSchema = createStateSchema('sidebarSessionStatus')

/** Client view schema (identical shape; the view is the state). */
export const viewSchema = createStateSchema('sidebarSessionStatus view')

/** Initial state: no turn has ended yet. */
export function init() {
  return { outcome: NO_TURN_OUTCOME, turn: -1 }
}

/**
 * Fold one committed Session event into the outcome state.
 *
 * Every event other than `turn/end` returns the same reference, which tells the
 * registry that this unit did no work. `turn/end` carries
 * `{ turn, reason: TurnEndReason }`; `reason.kind` is preserved verbatim so new
 * kinds never have to wait for a plugin release.
 *
 * @param {SessionOutcomeState} state Current state.
 * @param {{ type: string, data?: unknown }} event Committed Session event.
 * @returns {SessionOutcomeState} The next state, or `state` when unchanged.
 */
export function apply(state, event) {
  if (event === null || typeof event !== 'object' || event.type !== 'turn/end') return state
  const data = event.data
  if (data === null || typeof data !== 'object') return state
  const reason = data.reason
  const kind = reason !== null && typeof reason === 'object' && typeof reason.kind === 'string'
    ? reason.kind
    : ''
  if (kind === '') return state
  const turn = Number.isInteger(data.turn) ? data.turn : state.turn
  if (state.outcome === kind && state.turn === turn) return state
  return { outcome: kind, turn }
}

/**
 * Read the projection view from a state (the view is the state itself).
 * @param {SessionOutcomeState} state Current state.
 * @returns {SessionOutcomeState} The same reference.
 */
export function view(state) {
  return state
}

/** Unit definition registered on the Host `sessionProjections` service. */
export const projectionDefinition = {
  key: PROJECTION_KEY,
  stateVersion: 1,
  stateSchema,
  init,
  apply,
  wire: {
    viewSchema,
    view,
    // `summary: true` puts the view into every list row's projectionValues.
    summary: true,
  },
}
