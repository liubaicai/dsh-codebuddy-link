import test from 'node:test'
import assert from 'node:assert/strict'
import { CodeBuddyAdapter, CODEBUDDY_EFFORTS, type Runner } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'
import { CallRuntime } from '../src/runtime.ts'
import { runCodeBuddy } from '../src/runner.ts'
import { runCodeBuddyAcp } from '../src/acp.ts'
import { join } from 'node:path'
import { buildPrompt, parseResponse } from '../src/prompt.ts'
import type { GenerateOptions, Message, ReasoningEffortId, StreamChunk } from '@deepseek-ai/dsh-llm'

const message = (text: string, role = 'user') => ({ id: 'm1', role, source: {kind: role === 'assistant' ? 'model' : 'user'}, content: [{type: 'text', text}] }) as Message
const options: GenerateOptions = {provider: 'codebuddy', model: 'default', messages: [message('hello')]}
const collect = async (iter: AsyncIterable<StreamChunk>) => { const out: StreamChunk[] = []; for await (const c of iter) out.push(c); return out }
const providerConfig = (entry: Record<string, unknown> = {}) => resolveConfig({workspaceRoot: process.cwd(), ...entry}, {})
const dshTools = [{name:'read', description:'DSH-only tool schema sentinel', parameters:{}}]
const assertNoReplay = (out: StreamChunk[]) => {
  assert.ok(!out.some(c => c.type === 'tool-call-delta' || c.type === 'block-start' && c.blockType === 'tool-call' || c.type === 'block-end' && c.block.type === 'tool-call'))
  const finishes = out.filter(c => c.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0]?.reason.kind, 'stop')
}

test('configuration defaults are safe and malformed values fail', () => {
  const cfg = resolveConfig({}, {})
  assert.equal(cfg.tools, ''); assert.equal(cfg.permissionMode, 'dontAsk')
  assert.deepEqual(cfg.models, ['default'])
  assert.equal(resolveConfig({enabled: 'false'}, {}).enabled, false)
  assert.throws(() => resolveConfig({timeoutMs: -1}, {}))
  assert.throws(() => resolveConfig({permissionMode: 'bypassPermissions'}, {}))
  assert.throws(() => resolveConfig({models: ['bad model']}, {}))
  assert.deepEqual(resolveConfig({models: ['hy3', 'hy3']}, {}).models, ['default', 'hy3'])
  assert.deepEqual(resolveConfig({modelContext: {hy3: 262144}}, {}).modelContext, {hy3: 262144})
  assert.deepEqual(resolveConfig({}, {'DSH_CODEBUDDY_MODEL_CONTEXT': '{"gpt-5.5": 1050000}'}).modelContext, {'gpt-5.5': 1050000})
  assert.throws(() => resolveConfig({modelContext: []}, {}))
  assert.throws(() => resolveConfig({modelContext: {'bad model': 5}}, {}))
  assert.throws(() => resolveConfig({modelContext: {hy3: 1.5}}, {}))
  assert.throws(() => resolveConfig({modelContext: {hy3: 0}}, {}))
})

test('prompt carries full ordered history and runtime context without truncation', () => {
  const prompt = buildPrompt([message('first'), message('reply', 'assistant'), message('Time sampled while preparing turn')], [], 10000)
  assert.ok(prompt.indexOf('first') < prompt.indexOf('reply'))
  assert.ok(prompt.includes('Time sampled'))
  assert.throws(() => buildPrompt([message('long')], [], 2), /compact/)
  assert.throws(() => buildPrompt([{...message(''), content: [{type:'image'}]} as Message], [], 10000), /text only/)
})

test('structured tool envelope rejects unknown tools and malformed JSON args', () => {
  const tools = [{name:'read', description:'read', parameters:{}}]
  assert.deepEqual(parseResponse({text:'', toolCalls:[{name:'read', arguments:'{"path":"a"}'}]}, tools).toolCalls.length, 1)
  assert.throws(() => parseResponse({text:'', toolCalls:[{name:'delete',arguments:'{}'}]}, tools))
  assert.throws(() => parseResponse({text:'', toolCalls:[{name:'read',arguments:'[]'}]}, tools))
  assert.deepEqual(parseResponse('not json', tools), {text:'not json',toolCalls:[]})
  assert.throws(() => parseResponse('{"toolCalls":', tools))
})

test('parseResponse accepts whole fences but never executes prose examples', () => {
  const tools = [{name:'read', description:'read', parameters:{}}]
  const fenced = parseResponse('```json\n{"text":"hi","toolCalls":[]}\n```', tools)
  assert.equal(fenced.text, 'hi'); assert.equal(fenced.toolCalls.length, 0)
  // The `}` inside the arguments string is the balanced-scan challenge.
  const envelope = String.raw`{"text":"你好","toolCalls":[{"name":"read","arguments":"{\"path\":\"a\",\"note\":\"含 } 花括号\"}"}]}`
  const prose = parseResponse('好的，这是结果：' + envelope + ' 请查收。', tools)
  assert.equal(prose.text, '好的，这是结果：' + envelope + ' 请查收。'); assert.equal(prose.toolCalls.length, 0)
  assert.equal(parseResponse(envelope, tools).toolCalls[0]?.name, 'read')
})

test('ordinary calls use native tools and show progress as reasoning before the final answer', async () => {
  const runner: Runner = async function* (request) {
    assert.equal(request.tools, 'default'); assert.equal(request.permissionMode, 'dontAsk')
    assert.equal(request.model, undefined)
    assert.equal(request.systemPrompt, undefined)
    assert.match(request.appendSystemPrompt!, /native CodeBuddy tools/)
    assert.match(request.appendSystemPrompt!, /host instructions/)
    assert.equal(request.jsonSchema, undefined)
    assert.ok(!request.prompt.includes(dshTools[0]!.description))
    yield {type:'reasoning', delta:'think'}; yield {type:'text',delta:'working'}
    yield {type:'usage', input:10,output:5,cacheRead:3,cacheWrite:2}
    yield {type:'result',text:'done',sessionId:'s'}
  }
  const out = await collect(new CodeBuddyAdapter(providerConfig(), runner).stream({...options, system:'host instructions', tools:dshTools}))
  assert.deepEqual(out.filter(c => c.type === 'block-end').map(c => c.block), [{type:'reasoning',text:'thinkworking'},{type:'text',text:'done'}])
  assert.deepEqual(out.at(-2), {type:'usage',usage:{inputTokens:10,outputTokens:5,cacheReadTokens:3,cacheWriteTokens:2}})
  assert.deepEqual(out.at(-1), {type:'finish',reason:{kind:'stop'},replayState:{response:{sessionId:'s'}}})
  assertNoReplay(out)
})

test('ordinary calls never parse or replay DSH envelopes, even with available host tools', async () => {
  const envelopes = [
    '{"text":"checking","toolCalls":[{"name":"read","arguments":"{\\"path\\":\\"a\\"}"}]}',
    '{"type":"tool-call","name":"read","arguments":{"path":"a"}}',
    '{"toolCalls":',
  ]
  for (const text of envelopes) {
    const runner: Runner = async function* (request) {
      assert.equal(request.jsonSchema, undefined); assert.equal(request.tools, 'default')
      yield {type:'text',delta:text}
      yield {type:'result',text,structuredOutput:{toolCalls:[{name:'read',arguments:'not JSON'}]}}
    }
    const out = await collect(new CodeBuddyAdapter(providerConfig(), runner).stream({...options,tools:dshTools}))
    assert.deepEqual(out.filter(c => c.type === 'text-delta').map(c => c.text), [text])
    assert.deepEqual(out.filter(c => c.type === 'reasoning-delta').map(c => c.text), [text])
    assertNoReplay(out)
  }
})

test('ordinary calls select ACP while purpose calls retain restricted print transport', async () => {
  const cfg = providerConfig()
  const selected: Array<Parameters<CallRuntime['run']>[2]> = []
  class RecordingRuntime extends CallRuntime {
    override async *run(...args: Parameters<CallRuntime['run']>) {
      selected.push(args[2])
      assert.equal(args[1], 'model')
      assert.equal(args[3], undefined, 'provider must not register a tool-envelope validator')
      yield {type:'result' as const,text:'ok'}
    }
  }
  const adapter = new CodeBuddyAdapter(cfg, undefined, undefined, undefined, new RecordingRuntime(cfg))
  assertNoReplay(await collect(adapter.stream(options)))
  assertNoReplay(await collect(adapter.stream({...options,purpose:'session-title'})))
  assert.deepEqual(selected, [runCodeBuddyAcp, runCodeBuddy])
})

test('native operation events are sanitized progress, never DSH replay', async () => {
  const runner: Runner = async function* () {
    yield {type:'tool-start',id:'native-1',name:'read_file',input:{path:'private-input-path'}}
    yield {type:'tool-end',id:'native-1',name:'read_file',output:'private-output-content',isError:false}
    yield {type:'tool-start',id:'secret-native-id',name:'<script>private arguments</script>'}
    yield {type:'tool-end',id:'secret-native-id',name:'<script>private arguments</script>',isError:true}
    yield {type:'result',text:'done'}
  }
  const out = await collect(new CodeBuddyAdapter(providerConfig(), runner).stream({...options,tools:dshTools}))
  const progress = out.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
  assert.match(progress, /CodeBuddy 执行: read_file/)
  assert.match(progress, /CodeBuddy 完成: read_file/)
  assert.match(progress, /CodeBuddy 执行: native-tool/)
  assert.match(progress, /CodeBuddy 失败: native-tool/)
  assert.ok(!JSON.stringify(out).includes('private arguments'))
  assert.ok(!JSON.stringify(out).includes('secret-native-id'))
  assert.ok(!JSON.stringify(out).includes('private-input-path'))
  assert.ok(!JSON.stringify(out).includes('private-output-content'))
  assertNoReplay(out)
})

test('ordinary final text falls back to accumulated native text when result is empty', async () => {
  const runner: Runner = async function* () {
    yield {type:'text',delta:'hello '}; yield {type:'text',delta:'world'}
    yield {type:'result',text:''}
  }
  const out = await collect(new CodeBuddyAdapter(providerConfig(), runner).stream(options))
  assert.deepEqual(out.filter(c => c.type === 'block-end').map(c => c.block), [{type:'reasoning',text:'hello world'},{type:'text',text:'hello world'}])
  assertNoReplay(out)
})

test('ordinary calls require an explicit or session workspace and reject relative paths', async () => {
  let calls = 0
  const runner: Runner = async function* () { calls++; yield {type:'result',text:'ok'} }
  await assert.rejects(collect(new CodeBuddyAdapter(resolveConfig({},{}), runner).stream(options)), /requires a session workspace or explicit workspaceRoot/)
  await assert.rejects(collect(new CodeBuddyAdapter(providerConfig({workspaceRoot:'relative'}), runner).stream(options)), /absolute path/)
  assert.equal(calls, 0)
  const sessionWorkspace = join(process.cwd(), 'session-workspace')
  const configuredWorkspace = join(process.cwd(), 'configured-workspace')
  const paths: string[] = []
  const capture: Runner = async function* (request) { paths.push(request.cwd); yield {type:'result',text:'ok'} }
  const sessionCwd = (id: string) => id === 'session-1' ? sessionWorkspace : undefined
  await collect(new CodeBuddyAdapter(resolveConfig({},{}), capture, sessionCwd).stream({...options,sessionId:'session-1' as GenerateOptions['sessionId']}))
  await collect(new CodeBuddyAdapter(providerConfig({workspaceRoot:configuredWorkspace}), capture, sessionCwd).stream({...options,sessionId:'session-1' as GenerateOptions['sessionId']}))
  assert.deepEqual(paths, [sessionWorkspace, configuredWorkspace])
})

test('errors close open content and emit one terminal failure', async () => {
  const runner: Runner = async function* () { yield {type:'text',delta:'partial'}; throw new Error('401 authentication failed') }
  const out = await collect(new CodeBuddyAdapter(providerConfig(), runner).stream(options))
  assert.equal(out.at(-2)?.type, 'block-end')
  assert.equal(out.filter(c => c.type === 'finish').length, 1)
  const last = out.at(-1); assert.equal(last?.type === 'finish' && last.reason.kind,'error')
})

test('purpose calls stay restricted without a workspace and prepareCall binds the model route', async () => {
  const runner: Runner = async function* (request) {
    assert.equal(request.jsonSchema, undefined); assert.equal(request.model, 'hy3')
    assert.equal(request.tools, ''); assert.equal(request.permissionMode, 'dontAsk')
    assert.equal(request.dangerouslySkipPermissions, undefined)
    assert.equal(request.appendSystemPrompt, undefined)
    assert.equal(request.systemPrompt, 'title instructions')
    assert.ok(!request.prompt.includes(dshTools[0]!.description))
    yield {type:'text',delta:'title'}
    yield {type:'result',text:'title'}
  }
  const adapter = new CodeBuddyAdapter(resolveConfig({models:['hy3'],tools:'default',permissionMode:'acceptEdits',dangerouslySkipPermissions:true},{}), runner)
  const call = await adapter.prepareCall('codebuddy','hy3')
  const out = await collect(call.stream({...options,purpose:'session-title',system:'title instructions',tools:dshTools}))
  assert.deepEqual(out.filter(c => c.type === 'block-end').map(c => c.block), [{type:'text',text:'title'}])
  assertNoReplay(out)
})

test('ordinary native tools ignore legacy tool restrictions while preserving permission settings', async () => {
  for (const dangerouslySkipPermissions of [false, true]) {
    const runner: Runner = async function* (request) {
      assert.equal(request.tools, 'default')
      assert.equal(request.permissionMode, 'plan')
      assert.equal(request.dangerouslySkipPermissions, dangerouslySkipPermissions)
      yield {type:'result',text:'ok'}
    }
    const cfg = providerConfig({tools:'read',permissionMode:'plan',dangerouslySkipPermissions})
    assertNoReplay(await collect(new CodeBuddyAdapter(cfg, runner).stream(options)))
  }
})

test('saved plugin credential flows to the runner as an auth token override', async () => {
  const seen: Array<string | undefined> = []
  const runner: Runner = async function* (request) { seen.push(request.authToken); yield {type:'result',text:'ok'} }
  const cfg = providerConfig({models:['hy3']})
  await collect(new CodeBuddyAdapter(cfg, runner, undefined, async () => 'tok').stream({...options, model:'hy3'}))
  await collect(new CodeBuddyAdapter(cfg, runner, undefined, async () => { throw new Error('unreadable') }).stream({...options, model:'hy3'}))
  await collect(new CodeBuddyAdapter(cfg, runner).stream({...options, model:'hy3'}))
  assert.deepEqual(seen, ['tok', undefined, undefined])
})

test('resolveModel exposes 思考等级 efforts and stream forwards only valid effort', async () => {  const cfg = providerConfig({models:['hy3']})
  const resolved = await new CodeBuddyAdapter(cfg, async function* () { yield {type:'result',text:''} }).resolveModel('codebuddy','hy3')
  assert.deepEqual(resolved.reasoning?.efforts.map(e => e.id), [...CODEBUDDY_EFFORTS])
  assert.equal(new Set(resolved.reasoning!.efforts.map(e => e.name)).size, CODEBUDDY_EFFORTS.length)
  const seen: Array<string | undefined> = []
  const runner: Runner = async function* (request) { seen.push(request.effort); yield {type:'result',text:'ok'} }
  const adapter = new CodeBuddyAdapter(cfg, runner)
  await collect(adapter.stream({...options, model:'hy3', reasoningEffort: 'high' as ReasoningEffortId}))
  const invalid = await collect(adapter.stream({...options, model:'hy3', reasoningEffort: 'mega' as unknown as ReasoningEffortId}))
  assert.ok(invalid.some(event => event.type === 'finish' && event.reason.kind === 'error'))
  await collect(adapter.stream({...options, model:'hy3'}))
  cfg.reasoningEffort = 'max'
  await collect(adapter.stream({...options, model:'hy3'}))
  await collect(adapter.stream({...options, model:'hy3', reasoningEffort: 'auto' as ReasoningEffortId}))
  assert.deepEqual(seen, ['high', undefined, 'max', undefined])
})

test('resolveModel reports per-model context windows with config fallback', async () => {
  const cfg = resolveConfig({models: ['hy3', 'mystery'], modelContext: {hy3: 262144}}, {})
  const adapter = new CodeBuddyAdapter(cfg, async function* () { yield {type:'result',text:''} })
  assert.equal((await adapter.resolveModel('codebuddy', 'hy3')).context?.contextWindow, 262144)
  assert.equal((await adapter.resolveModel('codebuddy', 'mystery')).context?.contextWindow, cfg.contextWindow)
  assert.equal((await adapter.resolveModel('codebuddy', 'default')).context?.contextWindow, cfg.contextWindow)
})
