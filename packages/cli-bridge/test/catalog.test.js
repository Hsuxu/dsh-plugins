import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerCatalog } from '../lib/catalog.js'

test('catalog resolves reasoning efforts as id and name pairs', async () => {
  const adapters = []
  const backend = {
    id: 'fake',
    label: 'Fake',
    argv: ['fake'],
    model: 'default',
    defaultModel: 'default',
    listModels: async () => [{ id: 'default', name: 'Default', efforts: ['low', 'high'], defaultEffort: 'high' }],
  }
  registerCatalog({ llm: { registerAdapter: (providers, adapter) => adapters.push({ providers, adapter }) } }, () => backend)
  assert.equal(adapters.length, 1)
  const resolved = await adapters[0].adapter.resolveModel('cli-fake', 'default')
  assert.deepEqual(resolved.reasoning, {
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'high',
  })
})
