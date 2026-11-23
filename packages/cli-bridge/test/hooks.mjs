const STUBS = new Map([
  ['@deepseek-ai/dsh-agent', './stubs/dsh-agent.mjs'],
  ['@deepseek-ai/dsh-llm', './stubs/dsh-llm.mjs'],
])

export async function resolve(specifier, context, next) {
  const stub = STUBS.get(specifier)
  if (stub !== undefined) return { url: new URL(stub, import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
}
