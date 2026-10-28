import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseResponse } from '../src/prompt.ts'
import { CodeBuddyAdapter, type Runner } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'

const raw = readFileSync(new URL('./fixtures/deepseek-plain-final.txt', import.meta.url), 'utf8')
const tools = [{name:'pwsh',description:'PowerShell',parameters:{}}]

test('recorded final answer after tool results is preserved verbatim with no calls', () => {
  assert.deepEqual(parseResponse(raw, tools), {text:raw,toolCalls:[]})
  for (const text of ['你好！', '代码示例：\n```ts\nif (ok) { return 1 }\n```', '可以用 {a,b} 表示集合。']) {
    assert.deepEqual(parseResponse(text, tools), {text,toolCalls:[]})
  }
})

test('plain-text fallback never swallows empty or recognizable damaged call output', () => {
  for (const text of ['', '   ', '{"text":"partial', '{"toolCalls":[',
    '```json\n{"text":', '{"text":"x","toolCalls":[{"name":"missing","arguments":"{}"}]}',
    '<｜｜DSML｜｜ calls>', 'text\n<｜｜DSML｜｜ calls>', '<tool_call>{"name":"pwsh"}</tool_call>',
    '{"tool_calls":{}}', '{"function_call":{}}', '[{"name":"pwsh"}]',
  ]) assert.throws(() => parseResponse(text, tools), text)
})

test('adapter completes tool-result continuation with plain final text and retains usage', async () => {
  const runner: Runner = async function* (request) {
    assert.equal(request.tools, '')
    assert.equal(request.jsonSchema, undefined)
    assert.ok(request.prompt.includes('tool-result'))
    yield {type:'text',delta:raw}
    yield {type:'usage',input:53844,output:400,cacheRead:51072,cacheWrite:0}
    yield {type:'result',text:raw}
  }
  const messages = [{id:'r',role:'user',source:{kind:'user'},content:[{type:'tool-result',toolCallId:'previous',content:[{type:'text',text:'mode: native'}]}]}] as Message[]
  const out: StreamChunk[] = []
  for await (const chunk of new CodeBuddyAdapter(resolveConfig({},{}),runner).stream({provider:'codebuddy',model:'default',messages,tools})) out.push(chunk)
  assert.deepEqual(out.filter(c => c.type === 'text-delta').map(c => c.text), [raw])
  assert.equal(out.filter(c => c.type === 'tool-call-delta').length, 0)
  assert.equal(out.filter(c => c.type === 'finish').length, 1)
  assert.ok(out.some(c => c.type === 'usage' && c.usage.outputTokens === 400))
  const last = out.at(-1)
  assert.equal(last?.type === 'finish' && last.reason.kind, 'stop')
})
