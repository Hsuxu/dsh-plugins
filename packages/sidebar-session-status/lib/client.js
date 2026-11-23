/**
 * Browser half of dsh-sidebar-session-status.
 *
 * Two registrations:
 * - `sidebar.session.row.trailing` renders a small state dot per Session row.
 *   Its `data-dsh-session-status` attribute is what the stylesheet keys on, so
 *   the whole row is tinted without touching the shipped row component.
 * - `shell.overlay` mounts a renderless effect that asks the Workspace
 *   Controller to move the Workspace owning the Session open in the main view
 *   to the front of the Host-persisted Workspace order.
 *
 * This artifact is a classic script: it registers a lazy factory and runs every
 * side effect inside `apply`, with `ctx.effect` owning cleanup.
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-session-status',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Client locale namespace. */
    const NS = 'dsh-sidebar-session-status'
    /** Must match the Host projection key in `lib/projection.js`. */
    const PROJECTION_KEY = 'sidebarSessionStatus'
    /** Action the Workspace Browser itself uses for group reordering. */
    const REORDER_ACTION = 'workspace/insertBefore'
    /** Slot ids (unique inside their slot). */
    const DOT_ID = 'dsh-sidebar-session-status.dot'
    const PIN_ID = 'dsh-sidebar-session-status.pin-active'
    /** Attribute carrying the derived row state. */
    const STATE_ATTRIBUTE = 'data-dsh-session-status'
    /** States that render a dot and tint a row. */
    const RENDERED_STATES = new Set(['active', 'completed', 'review', 'interrupted', 'failed'])
    /**
     * Turn outcomes that mean "the turn did not finish on its own". `interrupted`
     * is a Host-level interruption, `aborted` is a cancelled turn; neither is a
     * failure, but both are worth surfacing.
     */
    const INTERRUPTED_OUTCOMES = new Set(['interrupted', 'aborted'])
    /**
     * Orange has no theme token (the palette stops at warn/error), so the
     * interrupted state carries its own accent that reads on light and dark.
     */
    const INTERRUPTED_ACCENT = '#e2811c'

    const DICT = {
      zh: {
        'state.active': '活动会话',
        'state.completed': '已完成，尚未查看',
        'state.review': '等待审核',
        'state.interrupted': '已中断，未完成',
        'state.failed': '上一轮失败',
      },
      en: {
        'state.active': 'Active session',
        'state.completed': 'Completed, not yet viewed',
        'state.review': 'Waiting for review',
        'state.interrupted': 'Interrupted before finishing',
        'state.failed': 'Last turn failed',
      },
    }

    const STYLES = `
[data-sidebar-list-area] [data-row-key^="session:"] {
  transition: background-color 120ms ease, box-shadow 120ms ease;
}
.dsh-session-status-dot {
  display: inline-block;
  flex: none;
  inline-size: 6px;
  block-size: 6px;
  border-radius: 50%;
  background: var(--dss-accent, var(--dsw-alias-label-tertiary, currentColor));
}
.dsh-session-status-dot[data-dsh-session-status="active"] { --dss-accent: var(--dsw-alias-trajectory-accent); }
.dsh-session-status-dot[data-dsh-session-status="completed"] { --dss-accent: var(--dsw-alias-state-success-primary); }
.dsh-session-status-dot[data-dsh-session-status="review"] { --dss-accent: var(--dsw-alias-state-warn-primary); }
.dsh-session-status-dot[data-dsh-session-status="failed"] { --dss-accent: var(--dsw-alias-state-error-primary); }
.dsh-session-status-dot[data-dsh-session-status="interrupted"] { --dss-accent: ${INTERRUPTED_ACCENT}; }
[data-sidebar-list-area] [data-row-key^="session:"]:has([${STATE_ATTRIBUTE}="active"]) { --dss-accent: var(--dsw-alias-trajectory-accent); }
[data-sidebar-list-area] [data-row-key^="session:"]:has([${STATE_ATTRIBUTE}="completed"]) { --dss-accent: var(--dsw-alias-state-success-primary); }
[data-sidebar-list-area] [data-row-key^="session:"]:has([${STATE_ATTRIBUTE}="review"]) { --dss-accent: var(--dsw-alias-state-warn-primary); }
[data-sidebar-list-area] [data-row-key^="session:"]:has([${STATE_ATTRIBUTE}="failed"]) { --dss-accent: var(--dsw-alias-state-error-primary); }
[data-sidebar-list-area] [data-row-key^="session:"]:has([${STATE_ATTRIBUTE}="interrupted"]) { --dss-accent: ${INTERRUPTED_ACCENT}; }
[data-sidebar-list-area] [data-row-key^="session:"]:has([${STATE_ATTRIBUTE}]) {
  box-shadow: inset 2px 0 0 0 var(--dss-accent);
}
[data-sidebar-list-area] [data-row-key^="session:"]:not([aria-selected="true"]):not(:hover):has([${STATE_ATTRIBUTE}]) {
  background-color: color-mix(in srgb, var(--dss-accent) 8%, transparent);
}
`

    /**
     * Derive the row state from Client-visible facts.
     *
     * Precedence mirrors the shipped row exactly where they overlap
     * (pending interaction, then running) and otherwise adds the states the
     * shipped row does not separate: a failed last turn, an interrupted or
     * cancelled turn, then the unfinished completion reminder.
     *
     * @param {object} input
     * @param {boolean} input.archived Whether the Workspace archive set has this Session.
     * @param {boolean} input.hasSession Whether the catalog still carries the row.
     * @param {object|undefined} input.session `SessionSummary`, when present.
     * @param {object|undefined} input.status `SessionStatus`, when present.
     * @returns {'archived'|'idle'|'review'|'active'|'failed'|'interrupted'|'completed'} Row state.
     */
    function deriveSessionState(input) {
      if (input.archived) return 'archived'
      const session = input.session
      if (input.hasSession !== true || session === undefined || session === null) return 'idle'
      if (session.blank === true) return 'idle'
      const status = input.status
      if (status !== undefined && status !== null && status.pendingInteraction !== undefined) return 'review'
      const running = status !== undefined && status !== null && status.running !== undefined
        ? status.running
        : session.running === true
      if (running === true) return 'active'
      const values = session.projectionValues
      const outcome = values === undefined || values === null ? undefined : values[PROJECTION_KEY]
      if (outcome !== undefined && outcome !== null && outcome.outcome === 'error') return 'failed'
      if (outcome !== undefined && outcome !== null && INTERRUPTED_OUTCOMES.has(outcome.outcome)) return 'interrupted'
      if (status !== undefined && status !== null && status.completionUnread === true) return 'completed'
      return 'idle'
    }

    /**
     * Find the Session the main view is showing.
     * @param {{ ids: readonly string[], byId: Record<string, object|undefined> }} state Session list snapshot.
     * @returns {string|undefined} Session id, or undefined when nothing is open.
     */
    function findMainViewSessionId(state) {
      if (state === undefined || state === null) return undefined
      for (const id of state.ids) {
        const row = state.byId[id]
        const retainedBy = row === undefined || row === null ? undefined : row.retainedBy
        if (retainedBy !== undefined && retainedBy !== null && (retainedBy.mainView ?? 0) > 0) return id
      }
      return undefined
    }

    /**
     * Resolve the Workspace accounting a Session.
     * @param {{ items: readonly { workspaceId: string, sessionIds: readonly string[] }[] }} snapshot Workspace snapshot.
     * @param {string|undefined} sessionId Session to look up.
     * @returns {string|undefined} Workspace id.
     */
    function workspaceOfSession(snapshot, sessionId) {
      if (sessionId === undefined || snapshot === undefined || snapshot === null) return undefined
      for (const view of snapshot.items) {
        if (view.sessionIds.includes(sessionId)) return view.workspaceId
      }
      return undefined
    }

    /** Install the stylesheet once and remove it with the owning effect. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      for (const stale of document.querySelectorAll('style[data-dsh-session-status-style]')) stale.remove()
      const element = document.createElement('style')
      element.setAttribute('data-dsh-session-status-style', '')
      element.textContent = STYLES
      document.head.appendChild(element)
      return () => { element.remove() }
    }

    /** One dot in the trailing cell of a Session row. */
    function SessionStatusDot(props) {
      const { sessionId, useSessions, useSessionStatus, useWorkspaces, t } = props
      const session = useSessions((state) => state.byId[sessionId])
      const status = useSessionStatus((snapshot) => snapshot.get(sessionId))
      const archived = useWorkspaces((state) => state.archivedSessionIds.includes(sessionId))
      const current = deriveSessionState({
        archived,
        hasSession: session !== undefined,
        session,
        status,
      })
      if (!RENDERED_STATES.has(current)) return null
      return h('span', {
        className: 'dsh-session-status-dot',
        [STATE_ATTRIBUTE]: current,
        role: 'img',
        title: t('state.' + current),
        'aria-label': t('state.' + current),
      })
    }

    /**
     * Renderless: leads the Host Workspace list with the project being worked in.
     *
     * The move only happens while that project's main-view Session is running,
     * which means a turn started — sending a new message. Opening a finished
     * Session therefore never reshuffles the list.
     */
    function PinActiveWorkspace(props) {
      const { ctx, workspaceId, firstWorkspaceId, running, useWorkspaceAccess } = props
      const allowed = useWorkspaceAccess(workspaceId, REORDER_ACTION)
      const lastAttempt = React.useRef(undefined)
      React.useEffect(() => {
        if (!allowed) return
        if (running !== true) return
        if (firstWorkspaceId === undefined || firstWorkspaceId === workspaceId) return
        if (ctx === undefined || ctx.workspaces === undefined) return
        const attempt = workspaceId + '|' + firstWorkspaceId
        if (lastAttempt.current === attempt) return
        lastAttempt.current = attempt
        Promise.resolve(ctx.workspaces.insertBefore(workspaceId, firstWorkspaceId)).catch((error) => {
          if (typeof console !== 'undefined' && typeof console.debug === 'function') {
            console.debug('[dsh-sidebar-session-status] cannot pin the running project:', error)
          }
        })
      }, [allowed, ctx, firstWorkspaceId, running, workspaceId])
      return null
    }

    /** Resolves the main-view Session's Workspace, then mounts the reorder effect. */
    function PinActiveProject(props) {
      const { ctx, useSessions, useSessionStatus, useWorkspaces, useWorkspaceAccess } = props
      const activeSessionId = useSessions(findMainViewSessionId)
      const statusRunning = useSessionStatus === undefined
        ? false
        : useSessionStatus((snapshot) => {
          const status = activeSessionId === undefined ? undefined : snapshot.get(activeSessionId)
          return status !== undefined && status !== null && status.running === true
        })
      const summaryRunning = useSessions((state) => {
        const session = activeSessionId === undefined ? undefined : state.byId[activeSessionId]
        return session !== undefined && session !== null && session.running === true
      })
      const activeWorkspaceId = useWorkspaces((state) => workspaceOfSession(state, activeSessionId))
      const firstWorkspaceId = useWorkspaces(
        (state) => (state.items.length > 0 ? state.items[0].workspaceId : undefined),
      )
      if (activeWorkspaceId === undefined) return null
      return h(PinActiveWorkspace, {
        ctx,
        workspaceId: activeWorkspaceId,
        firstWorkspaceId,
        running: statusRunning === true || summaryRunning === true,
        useWorkspaceAccess,
      })
    }

    /**
     * Register dictionaries, styles, and both slots.
     * @param {object} ctx Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), NS + ': dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => installStyles(), NS + ': styles')

      ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
        name: 'sidebar.session.row.trailing',
        id: DOT_ID,
        order: 20,
        locale: NS,
      }, (props) => h(SessionStatusDot, { ...props, t })))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: PIN_ID,
        order: 5,
        locale: NS,
      }, (props) => h(PinActiveProject, { ...props, ctx, t })))
    }

    return {
      inject: ['workspaces', 'slots', 'locale'],
      apply,
      /** Pure helpers used by the package tests. */
      __internals: {
        deriveSessionState,
        findMainViewSessionId,
        workspaceOfSession,
        SessionStatusDot,
        PinActiveWorkspace,
        PinActiveProject,
        DICT,
        DOT_ID,
        PIN_ID,
        PROJECTION_KEY,
        STATE_ATTRIBUTE,
      },
    }
  },
})
