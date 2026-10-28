import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseResponse } from '../src/prompt.ts'
import { CodeBuddyAdapter, type Runner } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const raw = readFileSync(new URL('./fixtures/deepseek-split-envelope.txt', import.meta.url), 'utf8')
const tools = [{name:'pwsh',description:'PowerShell',parameters:{}}]
const call = {name:'pwsh',arguments:JSON.stringify({command:'literal \\ path "quotes" {braces} [arrays]\nnew line'})}
const json = JSON.stringify
const full = json({text:'checking',toolCalls:[call]})

test('captured split response retains text and the complete pending call', () => {
  const [first, second] = raw.split('\n\n').map(part => JSON.parse(part))
  const result = parseResponse(raw, tools)
  assert.equal(result.text, first.text)
  assert.deepEqual(result.toolCalls, second.toolCalls)
  assert.equal(JSON.parse(result.toolCalls[0]!.arguments).description, 'Confirm developerTools maps to Coding Tools toggle')
})

test('complete, partial and adjacent envelope documents normalize without changing arguments', () => {
  for (const separator of ['', ' ', '\n', '\r\n\r\n']) {
    const split = json({text:'checking'}) + separator + json({toolCalls:[call]})
    assert.deepEqual(parseResponse(split, tools), {text:'checking',toolCalls:[call]})
    assert.deepEqual(parseResponse('```json\n' + split + '\n```', tools), {text:'checking',toolCalls:[call]})
  }
  assert.deepEqual(parseResponse({text:'done'}, tools), {text:'done',toolCalls:[]})
  assert.deepEqual(parseResponse(json({toolCalls:[call]}), tools), {text:'',toolCalls:[call]})
  assert.deepEqual(parseResponse(full + '\n' + full, tools), {text:'checking\n\nchecking',toolCalls:[call,call]})
  assert.deepEqual(parseResponse(json({text:'{literal} [brackets] "quote" \\ slash'}) + json({toolCalls:[]}), tools), {text:'{literal} [brackets] "quote" \\ slash',toolCalls:[]})
})

const bad = [
  full + '\n{"toolCalls":', full + '\n{"text":"unfinished}',
  full + '\n{"toolCalls":[}', full + '\n[]', full + '\n{}',
  full + '\n' + json({toolCalls:[{name:'missing',arguments:'{}'}]}),
  full + '\n' + json({toolCalls:[{name:'pwsh',arguments:'[]'}]}),
  full + '\n' + json({toolCalls:[{name:'pwsh',arguments:'{'}]}),
  full + '\n' + json({toolCalls:42}), full + '\n' + json({text:42}),
  full + '\n' + json({toolCalls:[{name:'pwsh',arguments:null}]}),
  full + '\n' + json({function_call:{}}),
  full + '\n' + json({text:'x',toolCalls:[],tool_calls:[]}),
  full + '\n' + json({toolCalls:Array.from({length:32}, () => call)}),
  '```json\n' + full, '```json\n' + full + '\n```\n{"toolCalls":',
  full + '\n```python\n' + full + '\n```',
  full + '\ntrailing prose\n' + full,
  full + '\n<tool_call>broken</tool_call>', full + '\n"toolCalls":', full + '\n]',
]

test('valid prefixes never hide broken, unknown or ambiguous suffix documents', () => {
  for (const input of bad) assert.throws(() => parseResponse(input, tools), input)
})

test('aggregate call limit applies across documents, with exact boundary accepted', () => {
  const document = json({toolCalls:[call]})
  assert.equal(parseResponse(document.repeat(32), tools).toolCalls.length, 32)
  assert.throws(() => parseResponse(document.repeat(33), tools))
  assert.throws(() => parseResponse(json({text:'x'}).repeat(65), tools))
})

async function replay(text: string, resultOnly = false): Promise<StreamChunk[]> {
  const runner: Runner = async function* (request) {
    assert.equal(request.tools, '')
    assert.equal(request.permissionMode, 'dontAsk')
    assert.equal(request.jsonSchema, undefined)
    if (!resultOnly) for (let i = 0; i < text.length; i += 17) yield {type:'text',delta:text.slice(i, i+17)}
    yield {type:'usage',input:83814,output:1125,cacheRead:77568,cacheWrite:0}
    if (resultOnly) yield {type:'result',text,sessionId:'split-fixture'}
  }
  const out: StreamChunk[] = []
  for await (const chunk of new CodeBuddyAdapter(resolveConfig({},{}), runner).stream({provider:'codebuddy',model:'default',messages:[],tools})) out.push(chunk)
  return out
}

test('adapter replays split fixture through fragmented stream and final result paths', async () => {
  const expected = parseResponse(raw, tools)
  for (const resultOnly of [false,true]) {
    const out = await replay(raw, resultOnly)
    assert.deepEqual(out.filter(c => c.type === 'text-delta').map(c => c.text), [expected.text])
    assert.deepEqual(out.filter(c => c.type === 'tool-call-delta').map(c => ({name:c.name,arguments:c.argumentsDelta})), expected.toolCalls)
    assert.equal(out.filter(c => c.type === 'finish').length, 1)
    const finish = out.at(-1)
    assert.equal(finish?.type === 'finish' && finish.reason.kind, 'tool-calls')
    assert.ok(out.some(c => c.type === 'usage' && c.usage.outputTokens === 1125))
  }
})

test('adapter validates entire response before calls and shows failures only as diagnostic text', async () => {
  for (const text of bad) {
    const out = await replay(text)
    assert.equal(out.filter(c => c.type === 'tool-call-delta' || c.type === 'block-start' && c.blockType === 'tool-call').length, 0)
    const diagnostic = out.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.match(diagnostic, /响应解析失败/)
    assert.ok(diagnostic.includes(text))
    assert.equal(out.filter(c => c.type === 'finish').length, 1)
    assert.equal(out.filter(c => c.type === 'usage').length, 1)
    const finish = out.at(-1)
    assert.equal(finish?.type === 'finish' && finish.reason.kind, 'error')
  }
})
