import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { currentBackend, printForce } from './backends.js'
import { ClaudeStream } from './claude-stream.js'
import { CodexStream } from './codex-stream.js'
import { AntigravityStream } from './antigravity-stream.js'
import { spawnAgent, stopAgent } from './process.js'

const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const STREAMS = { claude: ClaudeStream, codex: CodexStream, antigravity: AntigravityStream }

function textOf(blocks) {
  return (blocks ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
}

function userEnvelope(blocks) {
  const content = []
  for (const block of blocks ?? []) {
    if (block?.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block?.type === 'image' && typeof block.data === 'string') {
      content.push({ type: 'image', source: { type: 'base64', media_type: block.mimeType ?? block.mediaType ?? 'image/png', data: block.data } })
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}

async function printPrompt(blocks) {
  const parts = []
  const files = []
  for (const block of blocks ?? []) {
    if (block?.type === 'text') parts.push(block.text)
    else if (block?.type === 'image' && typeof block.data === 'string') {
      const mime = block.mimeType ?? block.mediaType
      const file = join(tmpdir(), `dsh-cli-subagent-${randomUUID()}.${IMAGE_EXT[mime] ?? 'png'}`)
      await writeFile(file, Buffer.from(block.data, 'base64'))
      files.push(file)
      parts.push(`[Attached image: ${file}]`)
    }
  }
  return { text: parts.join('\n\n'), files }
}

function runPrint({ argv, cwd, env, stdin, signal, onEvent }) {
  return new Promise((resolve, reject) => {
    const child = spawnAgent(argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env })
    let stderr = ''
    let stopped
    const onAbort = () => {
      stopped ??= stopAgent(child, 3000)
      stopped.catch(reject)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return
      try {
        onEvent(JSON.parse(line))
      } catch {
        stderr = (stderr + line + '\n').slice(-8192)
      }
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      Promise.resolve(stopped).then(() => resolve({ code, stderr: stderr.trim() }), reject)
    })
  })
}

/**
 * A one-shot delegation target backed by an external CLI. The model-facing tool
 * is `@deepseek-ai/dsh-tool-subagent`, which runs exactly one task and returns
 * the final answer; the CLI transcript itself never enters the DSH log.
 */
export function createCliSubagentProvider(backendId, home) {
  const providerName = `cli-${backendId}`
  return {
    name: providerName,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    async start(request) {
      const controller = new AbortController()
      const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
      const backend = currentBackend(backendId)
      const cwd = request.cwd ?? request.parent?.session?.header?.cwd ?? process.cwd()
      const run = {
        id: `cli-${backendId}-${randomUUID()}`,
        dispose: () => controller.abort(),
        result: (async () => {
          let text = ''
          const files = []
          try {
            const prompt = backend.stdin === 'json' ? { text: '', files } : await printPrompt(request.prompt)
            files.push(...prompt.files)
            const stream = new STREAMS[backend.dialect]((update) => {
              if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') text += update.content.text
            }, { inputIncludesCache: backend.inputIncludesCache })
            const argv = backend.printArgv({ model: backend.model ?? backend.defaultModel, effort: undefined, cwd, resume: undefined, force: printForce(backend), prompt: prompt.text })
            const outcome = await runPrint({
              argv,
              cwd,
              env: backend.printEnv({ ...process.env, NO_COLOR: '1', ...(home ? { HOME: home } : {}) }),
              stdin: backend.stdin === 'json' ? userEnvelope(request.prompt) : '',
              signal,
              onEvent: (event) => stream.push(event),
            })
            const failure = stream.failure() ?? (outcome.code !== 0 && !stream.result ? outcome.stderr || `${argv[0]} exited with code ${outcome.code}` : undefined)
            if (failure !== undefined) {
              return { output: [{ type: 'text', text: failure }], stopReason: 'error' }
            }
            return { output: [{ type: 'text', text: text || 'done' }], stopReason: 'completed' }
          } catch (error) {
            return { output: [{ type: 'text', text: String(error?.message ?? error) }], stopReason: 'error' }
          } finally {
            await Promise.all(files.map((file) => rm(file, { force: true })))
          }
        })(),
      }
      return run
    },
  }
}

/** Register one delegation target on the calling plugin scope. */
export function registerCliSubagent(ctx, backendId, home) {
  if (typeof ctx.subagents?.registerProvider !== 'function') return
  ctx.effect(() => ctx.subagents.registerProvider(createCliSubagentProvider(backendId, home)), `dsh-cli-bridge: ${backendId} subagent provider`)
}
