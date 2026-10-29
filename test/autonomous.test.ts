import test from 'node:test'
import assert from 'node:assert/strict'
import { CodeBuddyAdapter, type Runner } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'

const options: GenerateOptions = { provider:'codebuddy', model:'default', system:'Respect the current user task.', messages:[{id:'m', role:'user', source:{kind:'user'}, content:[{type:'text', text:'Review this project'}]} as Message], tools:[{name:'dsh_only_tool', description:'DSH_ONLY_SCHEMA_SENTINEL', parameters:{}}] }
const cfg = () => resolveConfig({dangerouslySkipPermissions:true, workspaceRoot:process.cwd()}, {})
const collect = async (source:AsyncIterable<StreamChunk>) => { const out:StreamChunk[]=[]; for await (const event of source) out.push(event); return out }
const finish = (out:StreamChunk[]) => { const event=out.at(-1); return event?.type === 'finish' ? event.reason.kind : undefined }

test('ACP execution is the fixed provider mode and legacy switches cannot downgrade it', () => {
  assert.equal(resolveConfig({},{}).executionMode,'autonomous')
  assert.equal(resolveConfig({},{}).dangerouslySkipPermissions,false)
  assert.equal(resolveConfig({}, {DSH_CODEBUDDY_EXECUTION_MODE:'bridge',DSH_CODEBUDDY_DANGEROUSLY_SKIP_PERMISSIONS:'true'}).dangerouslySkipPermissions,true)
  assert.equal(resolveConfig({executionMode:'bridge'},{DSH_CODEBUDDY_EXECUTION_MODE:'bridge'}).executionMode,'autonomous')
  assert.throws(() => resolveConfig({dangerouslySkipPermissions:'yes'},{}))
})

test('native mode uses CLI tools and final result without interpreting tool-shaped text', async () => {
  const final = '<｜｜DSML｜｜ parameter name="timeoutMs":30000'
  const runner:Runner = async function* (request) {
    assert.equal(request.tools,'default'); assert.equal(request.dangerouslySkipPermissions,true)
    assert.equal(request.systemPrompt,undefined); assert.equal(request.jsonSchema,undefined)
    assert.ok(request.appendSystemPrompt?.includes('Respect the current user task.'))
    assert.ok(request.appendSystemPrompt?.includes('native CodeBuddy tools'))
    assert.ok(!request.prompt.includes('DSH_ONLY_SCHEMA_SENTINEL'))
    assert.ok(!request.prompt.includes('Reply using NDJSON'))
    yield {type:'text',delta:'Checking now'}
    yield {type:'tool-start',id:'1',name:'Write',input:{secret:'ARGUMENT_SECRET'}}
    yield {type:'tool-end',id:'1',name:'Write',output:'OUTPUT_SECRET'}
    yield {type:'usage',input:20,output:8,cacheRead:0,cacheWrite:0}
    yield {type:'result',text:final,structuredOutput:{toolCalls:[{name:'dsh_only_tool'}]}}
  }
  const out = await collect(new CodeBuddyAdapter(cfg(),runner).stream(options))
  assert.equal(finish(out),'stop')
  assert.deepEqual(out.filter(e=>e.type==='text-delta').map(e=>e.text),[final])
  assert.ok(out.some(e=>e.type==='reasoning-delta' && e.text.includes('Write')))
  assert.ok(out.some(e=>e.type==='usage'))
  assert.ok(!out.some(e=>e.type==='tool-call-delta'))
  assert.ok(!JSON.stringify(out).includes('ARGUMENT_SECRET'))
  assert.ok(!JSON.stringify(out).includes('OUTPUT_SECRET'))
})

test('native fallback keeps streamed output and does not enable bypass implicitly', async () => {
  const config=cfg(); config.dangerouslySkipPermissions=false; config.permissionMode='plan'
  const runner:Runner=async function* (request) {
    assert.equal(request.tools,'default'); assert.equal(request.dangerouslySkipPermissions,false)
    assert.equal(request.permissionMode,'plan')
    yield {type:'text',delta:'Fallback final'}
    yield {type:'result',text:''}
  }
  const out=await collect(new CodeBuddyAdapter(config,runner).stream(options))
  assert.equal(finish(out),'stop')
  assert.deepEqual(out.filter(e=>e.type==='text-delta').map(e=>e.text),['Fallback final'])
})

test('housekeeping cannot gain native tools or permission bypass', async () => {
  const runner:Runner = async function* (request) {
    assert.equal(request.tools,''); assert.equal(request.dangerouslySkipPermissions,undefined)
    assert.equal(request.appendSystemPrompt,undefined); assert.equal(request.permissionMode,'dontAsk')
    yield {type:'result',text:'Title'}
  }
  const out = await collect(new CodeBuddyAdapter(cfg(),runner).stream({...options,purpose:'session-title'}))
  assert.equal(finish(out),'stop')
})

test('stored bridge preference cannot revive the DSH tool protocol', async () => {
  const config=resolveConfig({executionMode:'bridge', dangerouslySkipPermissions:true, workspaceRoot:process.cwd()}, {})
  assert.equal(config.executionMode,'autonomous')
  const runner:Runner = async function* (request) {
    assert.equal(request.tools,'default'); assert.equal(request.dangerouslySkipPermissions,true)
    yield {type:'result',text:'{"text":"ok","toolCalls":[]}'}
  }
  const out = await collect(new CodeBuddyAdapter(config,runner).stream(options))
  assert.equal(finish(out),'stop')
  assert.deepEqual(out.filter(e=>e.type==='text-delta').map(e=>e.text),['{"text":"ok","toolCalls":[]}'])
  assert.ok(!out.some(e=>e.type==='tool-call-delta'))
})

test('native execution requires explicit workspace and respects live session cwd', async () => {
  const config=cfg(); config.workspaceRoot=''
  const runner:Runner = async function* (request) { assert.equal(request.cwd,process.cwd()); yield {type:'result',text:'ok'} }
  await assert.rejects(collect(new CodeBuddyAdapter(config,runner).stream(options)), /requires a session workspace/)
  const adapter=new CodeBuddyAdapter(config,runner,()=>process.cwd())
  assert.equal(finish(await collect(adapter.stream({...options,sessionId:'s' as GenerateOptions['sessionId']}))),'stop')
})

test('native errors and cancellation remain terminal failures, no success replay', async () => {
  for (const aborted of [false,true]) {
    const controller=new AbortController()
    const runner:Runner=async function* () { yield {type:'text',delta:'Progress'}; if(aborted) controller.abort(); throw new Error('CLI failed') }
    const out=await collect(new CodeBuddyAdapter(cfg(),runner).stream({...options,signal:controller.signal}))
    assert.equal(finish(out),aborted?'aborted':'error')
    assert.equal(out.filter(e=>e.type==='finish').length,1)
    assert.equal(out.filter(e=>e.type==='text-delta').length,0)
    assert.ok(!JSON.stringify(out).includes('本次未执行任何工具调用'))
  }
})
