import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'

const modelKeys = ['defaultModel', 'models', 'hiddenModels', 'modelContext'] as const
const variables = { defaultModel: 'DSH_CODEBUDDY_DEFAULT_MODEL', models: 'DSH_CODEBUDDY_MODELS', hiddenModels: 'DSH_CODEBUDDY_HIDDEN_MODELS', modelContext: 'DSH_CODEBUDDY_MODEL_CONTEXT' }
function setting(key: typeof modelKeys[number], id: string): unknown {
  return key === 'modelContext' ? { [id]: 262144 } : key === 'defaultModel' ? id : [id]
}
function environment(key: typeof modelKeys[number], id: string): string {
  return key === 'modelContext' ? JSON.stringify(setting(key, id)) : id
}

for (const key of modelKeys) {
  test(`${key} shares the 256-character bare-ID bound for entry and environment`, () => {
    for (const length of [128, 129, 256]) {
      const id = 'm'.repeat(length)
      for (const config of [resolveConfig({ [key]: setting(key, id) }, {}), resolveConfig({}, { [variables[key]]: environment(key, id) })]) {
        if (key === 'defaultModel') assert.equal(config.defaultModel, id)
        else if (key === 'modelContext') assert.equal(config.modelContext[id], 262144)
        else assert.ok(config[key].includes(id))
      }
    }
    const invalid = ['m'.repeat(257), 'provider/model', 'https://host/model', '/tmp/model', './model', '../model', 'C:\\model', 'C:model', 'model\\name', 'model\n', 'model\r', 'model\t', 'model\0', 'model\x7f']
    for (const id of invalid) {
      assert.throws(() => resolveConfig({ [key]: setting(key, id) }, {}), /Invalid/, `${key} entry ${JSON.stringify(id)}`)
      assert.throws(() => resolveConfig({}, { [variables[key]]: environment(key, id) }), /Invalid/, `${key} environment ${JSON.stringify(id)}`)
    }
  })
}

test('configured bare IDs retain ordinary punctuation, space trimming and deduplication', () => {
  const config = resolveConfig({ defaultModel: ' vendor.model-v2:latest ', models: 'vendor.model-v2:latest, model_2', hiddenModels: ['model_2', 'model_2'], modelContext: { 'vendor.model-v2:latest': 262144 } }, {})
  assert.equal(config.defaultModel, 'vendor.model-v2:latest')
  assert.deepEqual(config.models, ['default', 'vendor.model-v2:latest', 'model_2'])
  assert.deepEqual(config.hiddenModels, ['model_2'])
})
