/** Minimal doubles of the DSH LLM helpers used at import time. */
export class LlmAdapter {}

export function createUserMessage(message) {
  return { id: 'test-user-message', role: 'user', ...message }
}

export class AssistantStreamAccumulator {
  constructor() {
    this.events = []
  }

  push(timed) {
    this.events.push(timed.chunk)
    return timed
  }

  snapshot() {
    return [...this.events]
  }
}

export class BlockAssembler {
  constructor() {
    this.list = []
  }

  push(chunk) {
    switch (chunk?.type) {
      case 'block-start':
        this.list[chunk.index] = { type: chunk.blockType, text: '' }
        break
      case 'text-delta':
        if (this.list[chunk.index]) this.list[chunk.index].text += chunk.text
        break
      case 'reasoning-delta':
        if (this.list[chunk.index]) this.list[chunk.index].text += chunk.text
        break
      case 'tool-call-delta': {
        const call = this.list[chunk.index]
        if (call?.type === 'tool-call') Object.assign(call, { id: chunk.id, name: chunk.name, arguments: chunk.argumentsDelta })
        break
      }
      case 'block-end':
        if (chunk.block?.type === 'tool-call' && this.list[chunk.index]) Object.assign(this.list[chunk.index], chunk.block)
        break
      default:
        break
    }
  }

  blocks() {
    return this.list.filter(Boolean)
  }
}
