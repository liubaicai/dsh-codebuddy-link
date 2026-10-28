import test from 'node:test'
import assert from 'node:assert/strict'
import { CodeBuddyAdapter, CODEBUDDY_EFFORTS, type Runner } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'
import { buildPrompt, parseResponse } from '../src/prompt.ts'
import type { GenerateOptions, Message, ReasoningEffortId, StreamChunk } from '@deepseek-ai/dsh-llm'

const message = (text: string, role = 'user') => ({ id: 'm1', role, source: {kind: role === 'assistant' ? 'model' : 'user'}, content: [{type: 'text', text}] }) as Message
const options: GenerateOptions = {provider: 'codebuddy', model: 'default', messages: [message('hello')]}
const collect = async (iter: AsyncIterable<StreamChunk>) => { const out: StreamChunk[] = []; for await (const c of iter) out.push(c); return out }

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

test('plain stream maps reasoning, text and disjoint usage before finish', async () => {
  const runner: Runner = async function* (request) {
    assert.equal(request.tools, ''); assert.equal(request.permissionMode, 'dontAsk')
    assert.equal(request.model, undefined)
    yield {type:'reasoning', delta:'think'}; yield {type:'text',delta:'hello'}
    yield {type:'usage', input:10,output:5,cacheRead:3,cacheWrite:2}
    yield {type:'result',text:'hello',sessionId:'s'}
  }
  const out = await collect(new CodeBuddyAdapter(resolveConfig({},{}), runner).stream(options))
  assert.deepEqual(out.filter(c => c.type === 'block-end').map(c => c.block), [{type:'reasoning',text:'think'},{type:'text',text:'hello'}])
  assert.equal(out.at(-2)?.type,'usage'); assert.equal(out.at(-1)?.type,'finish')
  assert.ok(!JSON.stringify(out).includes('undefined'))
})

test('tool calls execute through DSH, not CodeBuddy, with raw envelope hidden', async () => {
  const runner: Runner = async function* (request) {
    // The CLI's --json-schema mode is intentionally NOT used (cost/latency/reliability):
    // the envelope arrives as plain result text requested via the prompt.
    assert.equal(request.jsonSchema, undefined); assert.equal(request.tools,'')
    yield {type:'text',delta:'{"text":"checking"}'}
    yield {type:'result',text:'{"text":"checking","toolCalls":[{"name":"read","arguments":"{\\"path\\":\\"a\\"}"}]}'}
  }
  const out = await collect(new CodeBuddyAdapter(resolveConfig({},{}), runner).stream({...options,tools:[{name:'read',description:'read',parameters:{}}]}))
  assert.deepEqual(out.filter(c => c.type === 'text-delta').map(c => c.text),['checking'])
  assert.equal(out.filter(c => c.type === 'tool-call-delta').length,1)
  const last = out.at(-1); assert.equal(last?.type === 'finish' && last.reason.kind,'tool-calls')
})

test('errors close open content and emit one terminal failure', async () => {
  const runner: Runner = async function* () { yield {type:'text',delta:'partial'}; throw new Error('401 authentication failed') }
  const out = await collect(new CodeBuddyAdapter(resolveConfig({},{}), runner).stream(options))
  assert.equal(out.at(-2)?.type, 'block-end')
  assert.equal(out.filter(c => c.type === 'finish').length, 1)
  const last = out.at(-1); assert.equal(last?.type === 'finish' && last.reason.kind,'error')
})

test('auxiliary calls cannot execute tools and prepareCall binds model route', async () => {
  const runner: Runner = async function* (request) { assert.equal(request.jsonSchema,undefined); assert.equal(request.model,'hy3'); yield {type:'result',text:'title'} }
  const adapter = new CodeBuddyAdapter(resolveConfig({models:['hy3']},{}), runner)
  const call = await adapter.prepareCall('codebuddy','hy3')
  const out = await collect(call.stream({...options,purpose:'session-title',tools:[{name:'read',description:'',parameters:{}}]}))
  assert.ok(out.some(c => c.type === 'text-delta' && c.text === 'title'))
})

test('saved plugin credential flows to the runner as an auth token override', async () => {
  const seen: Array<string | undefined> = []
  const runner: Runner = async function* (request) { seen.push(request.authToken); yield {type:'result',text:'ok'} }
  const cfg = resolveConfig({models:['hy3']},{})
  await collect(new CodeBuddyAdapter(cfg, runner, undefined, async () => 'tok').stream({...options, model:'hy3'}))
  await collect(new CodeBuddyAdapter(cfg, runner, undefined, async () => { throw new Error('unreadable') }).stream({...options, model:'hy3'}))
  await collect(new CodeBuddyAdapter(cfg, runner).stream({...options, model:'hy3'}))
  assert.deepEqual(seen, ['tok', undefined, undefined])
})

test('resolveModel exposes 思考等级 efforts and stream forwards only valid effort', async () => {  const cfg = resolveConfig({models:['hy3']},{})
  const resolved = await new CodeBuddyAdapter(cfg, async function* () { yield {type:'result',text:''} }).resolveModel('codebuddy','hy3')
  assert.deepEqual(resolved.reasoning?.efforts.map(e => e.id), [...CODEBUDDY_EFFORTS])
  assert.equal(new Set(resolved.reasoning!.efforts.map(e => e.name)).size, CODEBUDDY_EFFORTS.length)
  const seen: Array<string | undefined> = []
  const runner: Runner = async function* (request) { seen.push(request.effort); yield {type:'result',text:'ok'} }
  const adapter = new CodeBuddyAdapter(cfg, runner)
  await collect(adapter.stream({...options, model:'hy3', reasoningEffort: 'high' as ReasoningEffortId}))
  await collect(adapter.stream({...options, model:'hy3', reasoningEffort: 'mega' as unknown as ReasoningEffortId}))
  await collect(adapter.stream({...options, model:'hy3'}))
  assert.deepEqual(seen, ['high', undefined, undefined])
})

test('resolveModel reports per-model context windows with config fallback', async () => {
  const cfg = resolveConfig({models: ['hy3', 'mystery'], modelContext: {hy3: 262144}}, {})
  const adapter = new CodeBuddyAdapter(cfg, async function* () { yield {type:'result',text:''} })
  assert.equal((await adapter.resolveModel('codebuddy', 'hy3')).context?.contextWindow, 262144)
  assert.equal((await adapter.resolveModel('codebuddy', 'mystery')).context?.contextWindow, cfg.contextWindow)
  assert.equal((await adapter.resolveModel('codebuddy', 'default')).context?.contextWindow, cfg.contextWindow)
})
