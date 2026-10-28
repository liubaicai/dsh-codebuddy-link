import test from 'node:test'
import assert from 'node:assert/strict'
import { CodeBuddyAdapter, type Runner } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'

test('disabled models cannot run even through stale session selection', async () => {
  let called = false
  const runner: Runner = async function* () { called = true; yield {type:'result',text:'ok'} }
  const adapter = new CodeBuddyAdapter(resolveConfig({models:['hy3'],hiddenModels:['hy3']},{}),runner)
  await assert.rejects(async () => {for await (const _ of adapter.stream({provider:'codebuddy',model:'hy3',messages:[]})) {}},/not enabled/)
  assert.equal(called,false)
})

test('selected model reaches CLI while provider tools remain DSH-owned', async () => {
  const runner: Runner = async function* (request) {
    assert.equal(request.model,'hy3'); assert.equal(request.tools,''); assert.equal(request.permissionMode,'dontAsk')
    yield {type:'result',text:'ok'}
  }
  const adapter = new CodeBuddyAdapter(resolveConfig({models:['hy3'],permissionMode:'acceptEdits',tools:'Read'},{}),runner)
  const chunks = []; for await (const chunk of adapter.stream({provider:'codebuddy',model:'hy3',messages:[]})) chunks.push(chunk)
  assert.equal(chunks.at(-1)?.type,'finish')
})
