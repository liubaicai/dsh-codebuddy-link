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
  const cfg = resolveConfig({workspaceRoot:process.cwd()}, {}), runtime = new CallRuntime(cfg)
  const adapter = new CodeBuddyAdapter(cfg, runner, undefined, undefined, runtime)
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({provider:'codebuddy',model:'default',messages:[],tools,signal})) chunks.push(chunk)
  return {chunks, runs:runtime.snapshots(), text:chunks.filter(c=>c.type==='text-delta').map(c=>c.text).join('')}
}
function assertFinish(chunks: StreamChunk[], kind: 'stop'|'error'|'aborted' = 'stop') {
  assert.equal(chunks.filter(c=>c.type==='finish').length,1)
  const finish=chunks.at(-1)
  assert.equal(finish?.type==='finish' && finish.reason.kind,kind)
  assert.equal(chunks.filter(c=>c.type==='tool-call-delta'||c.type==='block-start'&&c.blockType==='tool-call'||c.type==='block-end'&&c.block.type==='tool-call').length,0)
}

test('captured malformed envelope is an unchanged ACP final, not a parser diagnostic or replay', async()=>{
  assert.throws(()=>parseResponse(captured,tools),/tool call #3 arguments: trailing JSON data/)
  for(const streamed of [false,true]) {
    const result=await replay(async function*(){
      if(streamed) for(let i=0;i<captured.length;i+=7) yield {type:'text',delta:captured.slice(i,i+7)}
      yield {type:'usage',input:41242,output:550,cacheRead:0,cacheWrite:0}
      yield {type:'result',text:captured}
    })
    assertFinish(result.chunks)
    assert.equal(result.text,captured)
    assert.equal(result.chunks.filter(c=>c.type==='reasoning-delta').map(c=>c.text).join(''),streamed?captured:'')
    assert.deepEqual(result.chunks.filter(c=>c.type==='usage').map(c=>c.usage),[{inputTokens:41242,outputTokens:550,cacheReadTokens:0,cacheWriteTokens:0}])
    assert.equal(result.runs.length,1)
    assert.equal(result.runs[0]?.state,'completed')
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

test('ACP final preserves complete long Unicode response and nested Markdown fences without wrapping',async()=>{
  const body='{"text":'+JSON.stringify('汉字😀'.repeat(20000)+'\n``````\n<script>ignored</script>')+',"toolCalls":[}'
  const result=await replay(async function*(){yield {type:'result',text:body}})
  assertFinish(result.chunks)
  assert.equal(result.text,body)
  assert.deepEqual(result.chunks.filter(c=>c.type==='text-delta').map(c=>c.text),[body])
  assert.equal(result.runs[0]?.state,'completed')
})

test('final result overrides progress and structured metadata is never parsed or displayed',async()=>{
  const result=await replay(async function*(){
    yield {type:'text',delta:'PARTIAL-STREAM'}
    yield {type:'result',text:'final body',structuredOutput:{text:'x',toolCalls:[{name:'read',arguments:'{}]'}]}}
  })
  assertFinish(result.chunks)
  assert.equal(result.text,'final body')
  assert.deepEqual(result.chunks.filter(c=>c.type==='reasoning-delta').map(c=>c.text),['PARTIAL-STREAM'])
  assert.equal(result.runs[0]?.state,'completed')
  assert.ok(!JSON.stringify(result.chunks).includes('arguments'))
})

test('structured metadata is not inspected even when it has an accessor or cyclic value',async()=>{
  let inspected=0
  const structured:Record<string,unknown>={}
  Object.defineProperty(structured,'text',{enumerable:true,get(){inspected++;throw new Error('must not inspect structured output')}})
  structured.self=structured
  const result=await replay(async function*(){yield {type:'result',text:'unchanged',structuredOutput:structured}})
  assertFinish(result.chunks)
  assert.equal(result.text,'unchanged')
  assert.equal(inspected,0)
  assert.equal(result.runs[0]?.state,'completed')
})

test('stream-only malformed output is a final fallback, but failures and cancellation never invent a final',async()=>{
  const malformed='{"text":"x","toolCalls":[}'
  const stream=await replay(async function*(){yield {type:'text',delta:malformed}})
  assertFinish(stream.chunks); assert.equal(stream.text,malformed)
  assert.deepEqual(stream.chunks.filter(c=>c.type==='reasoning-delta').map(c=>c.text),[malformed])
  const transport=await replay(async function*(){yield {type:'text',delta:'NATIVE-PROGRESS'};throw new Error('transport failed')})
  assertFinish(transport.chunks,'error'); assert.equal(transport.text,'')
  assert.deepEqual(transport.chunks.filter(c=>c.type==='block-end').map(c=>c.block),[{type:'reasoning',text:'NATIVE-PROGRESS'}])
  assert.equal(transport.runs[0]?.state,'failed')
  const failed=transport.chunks.at(-1)
  assert.deepEqual(failed?.type==='finish'&&failed.reason.kind==='error'&&failed.reason.failure,{code:'CODEBUDDY_ERROR',message:'transport failed'})
  const stop=new AbortController()
  const cancelled=await replay(async function*(){yield {type:'text',delta:'NATIVE-PROGRESS'};stop.abort();throw new Error('cancelled')},stop.signal)
  assertFinish(cancelled.chunks,'aborted')
  assert.equal(cancelled.text,'')
  assert.deepEqual(cancelled.chunks.filter(c=>c.type==='block-end').map(c=>c.block),[{type:'reasoning',text:'NATIVE-PROGRESS'}])
  assert.equal(cancelled.runs[0]?.state,'cancelled')
  const finish=cancelled.chunks.at(-1)
  assert.deepEqual(finish?.type==='finish'&&finish.reason.kind==='aborted'&&finish.reason.failure,{code:'ABORTED',message:'cancelled'})
})

test('JSON fences never close on Unicode separators inside a legal JSON string',()=>{
  for(const separator of ['\u2028','\u2029']) for(const newline of ['\n','\r\n']) {
    const text=`before${separator}\`\`\`${separator}after`
    const wire=JSON.stringify({text,toolCalls:[]})
    assert.deepEqual(parseResponse('```json'+newline+wire+newline+'```',tools),{text,toolCalls:[]})
  }
})
