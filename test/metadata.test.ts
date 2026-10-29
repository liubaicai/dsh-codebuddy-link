import assert from 'node:assert/strict'
import test from 'node:test'
import { isModelIdentifier } from '../src/metadata.ts'
import { isRequestModelIdentifier, isReturnedModelIdentifier, MAX_MODEL_ID_LENGTH } from '../src/model-id.ts'
import { resolveConfig } from '../src/config.ts'
import { CallRuntime } from '../src/runtime.ts'

test('request and returned model domains share explicit inclusive 256-character bounds', () => {
  assert.equal(MAX_MODEL_ID_LENGTH, 256)
  assert.equal(isModelIdentifier, isReturnedModelIdentifier)
  for (const length of [128, 129, 256, 257]) {
    const bare = 'm'.repeat(length), qualified = `provider/${'m'.repeat(length - 9)}`
    assert.equal(isRequestModelIdentifier(bare), length <= 256)
    assert.equal(isModelIdentifier(bare), length <= 256)
    assert.equal(isModelIdentifier(qualified), length <= 256)
    assert.equal(isRequestModelIdentifier(qualified), false)
  }
})

test('model metadata accepts provider/name but rejects URLs, paths and controls', () => {
  for (const id of ['default', 'vendor.model-v2:latest', 'provider/model-v2:latest']) assert.equal(isModelIdentifier(id), true, id)
  for (const id of [null, 123, {}, '', 'https://host/model', 'file:///tmp/model', '/tmp/model', './model', '../model', 'C:\\model', 'C:model', 'C:/model', 'model\\name', 'provider//model', 'provider/model/extra', 'provider/../model', 'provider/.', 'provider/..', 'provider/', 'model\n', 'model\r', 'model\t', 'model\0', 'model\x7f', ' model', 'model ']) {
    assert.equal(isModelIdentifier(id), false, JSON.stringify(id))
    assert.equal(isRequestModelIdentifier(id), false, JSON.stringify(id))
  }
})

test('128/129/256-character configured IDs retain runtime model and context metadata', async () => {
  for (const length of [128, 129, 256]) {
    const id = 'm'.repeat(length)
    const config = resolveConfig({ defaultModel: id, modelContext: { [id]: 262144 } }, {})
    const runtime = new CallRuntime(config)
    for await (const _event of runtime.run({ cwd: '.', prompt: 'fixture', model: config.defaultModel }, 'model', async function* () {
      yield { type: 'metadata', model: id }
      yield { type: 'result', text: '' }
    })) { /* consume */ }
    const run = runtime.snapshots()[0]!
    assert.equal(run.requestedModel, id)
    assert.equal(run.returnedModel, id)
    assert.equal(run.contextWindow, 262144)
    assert.equal(run.contextSource, 'model')
  }
})
