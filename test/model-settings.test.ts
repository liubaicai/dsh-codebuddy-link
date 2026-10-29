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

test('selected model reaches native provider independently of ask tools', async () => {
  let called = false
  const runner: Runner = async function* (request) {
    called = true
    assert.equal(request.model,'hy3'); assert.equal(request.tools,'default'); assert.equal(request.permissionMode,'acceptEdits')
    assert.equal(request.dangerouslySkipPermissions,false)
    yield {type:'result',text:'ok'}
  }
  const adapter = new CodeBuddyAdapter(resolveConfig({models:['hy3'],permissionMode:'acceptEdits',tools:'Read',workspaceRoot:process.cwd()},{}),runner)
  const chunks = []; for await (const chunk of adapter.stream({provider:'codebuddy',model:'hy3',messages:[]})) chunks.push(chunk)
  assert.equal(called,true)
  const finish = chunks.at(-1)
  assert.equal(finish?.type === 'finish' ? finish.reason.kind : undefined,'stop')
})
