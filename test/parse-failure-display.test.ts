import assert from 'node:assert/strict'
import test from 'node:test'
import { CodeBuddyAdapter, type Runner } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'
import { CallRuntime } from '../src/runtime.ts'
import { buildPrompt, parseResponse, RESPONSE_SCHEMA } from '../src/prompt.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const tools = [{name:'glob',description:'find',parameters:{}}, {name:'read',description:'read',parameters:{}}]
// Exact content recovered from the step-5-preview trace for the reported failure.
const captured = String.raw`{"text":"开始对项目 dsh-codebuddy-link 做只读审查。先摸清仓库结构和关键配置。","toolCalls":[{"name":"glob","arguments":"{\"pattern\":\"**/*\",\"path\":\".\"}"},{"name":"read","arguments":"{\"file_path\":\"README.md\"}"},{"name":"read","arguments":"{\"file_path\":\"package.json\"}]"}]}`
async function replay(runner: Runner, signal?: AbortSignal) {
  const cfg = resolveConfig({}, {}), runtime = new CallRuntime(cfg)
  const adapter = new CodeBuddyAdapter(cfg, runner, undefined, undefined, runtime)
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({provider:'codebuddy',model:'default',messages:[],tools,signal})) chunks.push(chunk)
  return {chunks, runs:runtime.snapshots(), text:chunks.filter(c=>c.type==='text-delta').map(c=>c.text).join('')}
}
function assertFailure(chunks: StreamChunk[]) {
  assert.equal(chunks.filter(c=>c.type==='finish').length,1)
  const finish=chunks.at(-1)
  assert.equal(finish?.type==='finish' && finish.reason.kind,'error')
  assert.equal(chunks.filter(c=>c.type==='tool-call-delta'||c.type==='block-start'&&c.blockType==='tool-call').length,0)
}

test('real trailing bracket failure displays final reply once and executes none of its three calls', async()=>{
  assert.throws(()=>parseResponse(captured,tools),/tool call #3 arguments: trailing JSON data/)
  for(const streamed of [false,true]) {
    const result=await replay(async function*(){
      if(streamed) for(let i=0;i<captured.length;i+=7) yield {type:'text',delta:captured.slice(i,i+7)}
      yield {type:'usage',input:41242,output:550,cacheRead:0,cacheWrite:0}
      yield {type:'result',text:captured}
    })
    assertFailure(result.chunks)
    assert.match(result.text,/本次未执行任何工具调用/)
    assert.equal(result.text.split(captured).length,2)
    assert.equal(result.chunks.filter(c=>c.type==='usage').length,1)
    assert.equal(result.runs[0]?.state,'failed')
    assert.ok(!JSON.stringify(result.runs).includes('package.json'))
  }
})

test('object arguments avoid nested string encoding while legacy valid strings remain compatible',()=>{
  const fixed=JSON.parse(captured)
  fixed.toolCalls[2].arguments={file_path:'package.json'}
  const parsed=parseResponse(JSON.stringify(fixed),tools)
  assert.equal(parsed.toolCalls.length,3)
  assert.deepEqual(JSON.parse(parsed.toolCalls[2]!.arguments),{file_path:'package.json'})
  const prompt=buildPrompt([],tools,10000)
  assert.match(prompt,/arguments MUST be a JSON object/)
  assert.doesNotMatch(prompt,/<JSON-encoded object string>/)
  const schema=RESPONSE_SCHEMA as any
  assert.equal(schema.properties.toolCalls.items.properties.arguments.type,'object')
})

test('diagnostic preserves complete long Unicode response and protects nested Markdown fences',async()=>{
  const body='{"text":'+JSON.stringify('汉字😀'.repeat(20000)+'\n``````\n<script>ignored</script>')+',"toolCalls":[}'
  const result=await replay(async function*(){yield {type:'result',text:body}})
  assertFailure(result.chunks)
  assert.ok(result.text.includes(body))
  assert.match(result.text,/```````text\n/)
  assert.ok(result.text.endsWith('\n```````'))
})

test('result overrides partial stream; structured value also appears when it was the failed parse input',async()=>{
  const result=await replay(async function*(){
    yield {type:'text',delta:'PARTIAL-STREAM'}
    yield {type:'result',text:'final body',structuredOutput:{text:'x',toolCalls:[{name:'read',arguments:'{}]'}]}}
  })
  assertFailure(result.chunks)
  assert.ok(result.text.includes('final body'))
  assert.ok(result.text.includes(JSON.stringify({text:'x',toolCalls:[{name:'read',arguments:'{}]'}]},null,2)))
  assert.ok(!result.text.includes('PARTIAL-STREAM'))
})

test('stream-only parse failure is visible, but transport failures and cancellation do not expose output',async()=>{
  const malformed='{"text":"x","toolCalls":[}'
  const stream=await replay(async function*(){yield {type:'text',delta:malformed}})
  assertFailure(stream.chunks); assert.ok(stream.text.includes(malformed))
  const transport=await replay(async function*(){yield {type:'text',delta:'PRIVATE-PARTIAL'};throw new Error('transport failed')})
  assertFailure(transport.chunks); assert.equal(transport.text,'')
  const stop=new AbortController()
  const cancelled=await replay(async function*(){yield {type:'text',delta:'PRIVATE-PARTIAL'};stop.abort();throw new Error('cancelled')},stop.signal)
  assert.equal(cancelled.text,'')
  const finish=cancelled.chunks.at(-1)
  assert.equal(finish?.type==='finish'&&finish.reason.kind,'aborted')
})

test('JSON fences never close on Unicode separators inside a legal JSON string',()=>{
  for(const separator of ['\u2028','\u2029']) for(const newline of ['\n','\r\n']) {
    const text=`before${separator}\`\`\`${separator}after`
    const wire=JSON.stringify({text,toolCalls:[]})
    assert.deepEqual(parseResponse('```json'+newline+wire+newline+'```',tools),{text,toolCalls:[]})
  }
})
