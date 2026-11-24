import { createInterface } from 'node:readline'
import { spawnAgent, stopAgent } from './process.js'

/**
 * Minimal JSON-RPC client for `codex app-server`.
 *
 * The app-server speaks one JSON object per line. Requests carry a numeric id;
 * notifications carry only a method. The server can also send requests (for
 * example an approval prompt), which are declined here because Plan mode runs
 * with `approvalPolicy: 'never'` and a read-only sandbox.
 */
export class CodexAppClient {
  constructor({ backend, cwd, env, onNotification, onServerRequest, name = 'dsh-cli-bridge', version = '0.1.0' }) {
    this.backend = backend
    this.cwd = cwd
    this.env = env
    this.onNotification = onNotification
    this.onServerRequest = onServerRequest
    this.name = name
    this.version = version
    this.child = null
    this.lines = null
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.closed = false
    this.starting = null
  }

  get argv() {
    return [...this.backend.argv, 'app-server']
  }

  async start() {
    if (this.starting) return this.starting
    this.starting = this.#start()
    return this.starting
  }

  async #start() {
    this.child = spawnAgent(this.argv, {
      cwd: this.cwd,
      env: this.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stderr?.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8192)
    })
    this.child.on('error', (error) => this.#fail(error))
    this.child.on('close', (code) => {
      if (!this.closed) this.#fail(new Error(`codex app-server exited with code ${code ?? 'unknown'}: ${this.stderr.trim()}`))
    })
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', (line) => this.#line(line))
    await this.request('initialize', {
      clientInfo: { name: this.name, version: this.version },
      capabilities: { experimentalApi: true },
    }, 30_000)
    this.notify('initialized', {})
  }

  request(method, params, timeoutMs = 120_000) {
    if (this.closed) return Promise.reject(new Error('codex app-server is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`codex app-server request timed out: ${method}`))
        }, timeoutMs)
        : null
      this.pending.set(id, {
        method,
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.lines?.close()
    this.#fail(new Error('codex app-server closed'))
    if (this.child) await stopAgent(this.child, 3000).catch(() => {})
  }

  #write(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('codex app-server stdin is not writable')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #fail(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  #line(line) {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.stderr = (this.stderr + line + '\n').slice(-8192)
      return
    }
    if (message.id !== undefined && message.id !== null && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.id !== null && typeof message.method === 'string') {
      void this.#serverRequest(message)
      return
    }
    if (typeof message.method === 'string') this.onNotification?.(message.method, message.params ?? {})
  }

  async #serverRequest(message) {
    const method = message.method
    try {
      if (/requestApproval$/i.test(method)) {
        this.#write({ jsonrpc: '2.0', id: message.id, result: { decision: 'decline' } })
        return
      }
      if (method === 'tool/requestUserInput') {
        this.#write({ jsonrpc: '2.0', id: message.id, result: { answers: {} } })
        return
      }
      const handled = await this.onServerRequest?.(method, message.params ?? {})
      if (handled !== undefined) {
        this.#write({ jsonrpc: '2.0', id: message.id, result: handled })
        return
      }
      this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported server request: ${method}` } })
    } catch (error) {
      this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
    }
  }
}
