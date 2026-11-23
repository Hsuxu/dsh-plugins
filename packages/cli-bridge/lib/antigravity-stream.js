/**
 * The Antigravity CLI `agy -p --output-format stream-json` transcript, translated
 * into the ACP `session/update` shapes TurnWriter reads.
 *
 * Every line is one JSON object: `init` names the conversation a later turn
 * resumes with `--conversation <id>`, `step_update` reports one step of the
 * turn, and `result` ends it with the final response and the token usage.
 */

const TOOL_KINDS = new Map([
  ['run_command', 'execute'],
  ['run_shell_command', 'execute'],
  ['execute_command', 'execute'],
  ['shell', 'execute'],
  ['bash', 'execute'],
  ['read_file', 'read'],
  ['view_file', 'read'],
  ['write_file', 'edit'],
  ['edit_file', 'edit'],
  ['replace_file_content', 'edit'],
  ['multi_edit', 'edit'],
  ['search', 'search'],
  ['grep', 'search'],
  ['glob', 'search'],
  ['web_fetch', 'fetch'],
  ['web_search', 'fetch'],
])

function toolKind(name) {
  return TOOL_KINDS.get(String(name ?? '').toLowerCase()) ?? 'other'
}

function outputText(output) {
  if (output === undefined || output === null) return ''
  if (typeof output === 'string') return output
  if (typeof output === 'object') {
    if (typeof output.content === 'string') return output.content
    if (typeof output.stdout === 'string' || typeof output.stderr === 'string') {
      return [output.stdout, output.stderr ? `[stderr]\n${output.stderr}` : ''].filter(Boolean).join('\n')
    }
  }
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

function toolCall(step) {
  const info = step.tool_info ?? {}
  const name = step.tool_name || info.name || 'tool'
  const parameters = info.parameters && typeof info.parameters === 'object' ? info.parameters : {}
  const path = parameters.file_path ?? parameters.path
  return {
    sessionUpdate: 'tool_call',
    toolCallId: step.id,
    kind: toolKind(name),
    title: typeof parameters.command === 'string' ? parameters.command : typeof path === 'string' ? `${name} ${path}` : name,
    rawInput: parameters,
    ...(typeof path === 'string' ? { locations: [{ path }] } : {}),
    status: 'in_progress',
  }
}

function toolResult(step) {
  const info = step.tool_info ?? {}
  const kind = toolKind(step.tool_name || info.name)
  const failed = step.state !== 'DONE' || Boolean(info.error)
  const update = { sessionUpdate: 'tool_call_update', toolCallId: step.id, status: failed ? 'failed' : 'completed' }
  const output = info.output
  if (kind === 'execute' && output && typeof output === 'object') {
    update.rawOutput = {
      stdout: typeof output.stdout === 'string' ? output.stdout : '',
      stderr: typeof output.stderr === 'string' ? output.stderr : '',
      exitCode: Number.isFinite(output.exit_code) ? output.exit_code : Number.isFinite(output.exitCode) ? output.exitCode : null,
    }
    return update
  }
  const text = info.error?.message || outputText(output) || (failed ? 'failed' : 'done')
  update.content = [{ type: 'content', content: { type: 'text', text } }]
  return update
}

export class AntigravityStream {
  /** @param update - receives each ACP `session/update` payload. */
  constructor(update) {
    this.update = update
    this.sessionId = undefined
    this.result = undefined
    this.sawText = false
    this.tools = new Map()
    this.steps = new Map()
    this.turnUsage = undefined
  }

  recordable() {
    return true
  }

  text(text) {
    if (!text) return
    this.sawText = true
    this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  }

  step(step) {
    if (!step || typeof step !== 'object') return
    if (typeof step.conversation_id === 'string') this.sessionId = step.conversation_id
    if (Number.isFinite(step.step_index)) this.steps.set(step.step_index, step)
    if (step.usage && typeof step.usage === 'object') this.turnUsage = step.usage
    switch (step.step_type) {
      case 'agent_response':
        this.text(step.text_delta)
        break
      case 'tool': {
        const info = step.tool_info ?? {}
        const id = String(info.tool_call_id ?? info.id ?? `agy-tool-${step.step_index}`)
        const entry = { ...step, id }
        if (!this.tools.has(id)) {
          this.tools.set(id, entry)
          this.update(toolCall(entry))
          if (step.state === 'DONE' || info.output !== undefined || info.error) this.update(toolResult(entry))
        } else {
          const known = this.tools.get(id)
          const merged = { ...known, ...entry, tool_info: { ...known.tool_info, ...info } }
          this.tools.set(id, merged)
          if (step.state === 'DONE' || info.output !== undefined || info.error) this.update(toolResult(merged))
        }
        break
      }
      default:
        break
    }
  }

  /** @param event - one parsed transcript line. */
  push(event) {
    switch (event?.event) {
      case 'init':
        this.sessionId = event.conversation_id ?? event.init?.conversation_id ?? this.sessionId
        break
      case 'step_update':
        this.step(event.step_update)
        break
      case 'result': {
        const result = event.result ?? {}
        this.result = result
        if (typeof result.conversation_id === 'string') this.sessionId = result.conversation_id
        if (result.usage && typeof result.usage === 'object') this.turnUsage = result.usage
        if (!this.sawText && typeof result.response === 'string' && result.response) this.text(result.response)
        break
      }
      default:
        break
    }
  }

  /** Why the turn failed, or undefined when it did not. */
  failure() {
    if (!this.result) return
    if (this.result.status === 'SUCCESS') return
    const error = this.result.error
    if (typeof error === 'string' && error) return error
    if (typeof error?.message === 'string' && error.message) return error.message
    if (this.result.status === 'ERROR' || this.result.status === 'INVALID') return typeof this.result.response === 'string' && this.result.response ? this.result.response : 'Antigravity reported an error'
    if (this.result.status === 'CANCELED' || this.result.status === 'INTERRUPTED') return 'Antigravity turn was interrupted'
    return `Antigravity turn did not finish (${this.result.status ?? 'unknown'})`
  }

  /** Token usage of the turn in DSH's shape. */
  usage() {
    const u = this.turnUsage
    if (!u || typeof u !== 'object') return
    const n = (v) => (Number.isFinite(v) ? v : 0)
    return {
      inputTokens: n(u.input_tokens),
      outputTokens: n(u.output_tokens),
      cacheReadTokens: n(u.cache_read_tokens),
      cacheWriteTokens: n(u.cache_write_tokens),
      ...(Number.isFinite(u.thinking_tokens) && { reasoningTokens: u.thinking_tokens }),
    }
  }
}
