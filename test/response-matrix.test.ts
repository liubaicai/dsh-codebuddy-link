import test from 'node:test'
import assert from 'node:assert/strict'
import { parseResponse } from '../src/prompt.ts'
import { CodeBuddyAdapter, type Runner } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const tools = [{name:'pwsh',description:'shell',parameters:{}}]
const args = {command:'你好 \\ a "quoted" {braces} [arrays]\nnext', nested:{list:[true,null,3]}}
const encoded = JSON.stringify(args, null, 2)
const call = (a: unknown) => ({name:'pwsh',arguments:a})
const fn = (a: unknown) => ({id:'call-1',type:'function',function:call(a)})
const cases: [string,(a: unknown) => unknown][] = [
  ['DSH',a => ({text:'',toolCalls:[call(a)]})],
  ['OpenAI',a => ({role:'assistant',content:null,tool_calls:[fn(a)]})],
  ['OpenAI legacy',a => ({content:'',function_call:call(a)})],
  ['OpenAI completion',a => ({choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[fn(a)]}}],usage:{}})],
  ['message wrapper',a => ({message:{content:null,tool_calls:[fn(a)]}})],
  ['Anthropic',a => ({type:'message',role:'assistant',content:[{type:'tool_use',id:'a',name:'pwsh',input:a}],stop_reason:'tool_use'})],
  ['Gemini',a => ({role:'model',parts:[{functionCall:{name:'pwsh',args:a}}]})],
  ['Gemini content',a => ({content:{role:'model',parts:[{functionCall:{name:'pwsh',args:a}}]}})],
  ['Gemini candidate',a => ({candidates:[{content:{role:'model',parts:[{functionCall:{name:'pwsh',args:a}}]},finishReason:'STOP'}]})],
  ['bare call',a => call(a)],
  ['call array',a => [call(a)]],
  ['block array',a => [{type:'tool_use',name:'pwsh',input:a}]],
  ['tool-call block',a => ({type:'tool-call',id:'dsh-id',...call(a)})],
  ['Responses function_call',a => ({type:'function_call',id:'fc-id',call_id:'response-id',status:'completed',...call(a)})],
  ['Responses output',a => ({object:'response',status:'completed',output:[{type:'function_call',id:'fc-id',call_id:'response-id',status:'completed',...call(a)}]})],
  ['Gemini signature',a => ({parts:[{functionCall:{name:'pwsh',args:a},thoughtSignature:'opaque-signature'}]})],
  ['parameters alias',a => ({name:'pwsh',parameters:a})],
]
const transports: [string,(v: unknown) => unknown][] = [
  ['object',v=>v],['JSON',JSON.stringify],
  ['fence',v=>'```json\n'+JSON.stringify(v)+'\n```'],
  ['bare fence',v=>'```\n'+JSON.stringify(v)+'\n```'],
  ['BOM CRLF',v=>'\uFEFF \r\n'+JSON.stringify(v)+'\r\n'],
  ['double encoded',v=>JSON.stringify(JSON.stringify(v))],
]
for (const [format,make] of cases) for (const [transport,wrap] of transports) for (const [kind,a] of [['string',encoded],['object',args]] as const) {
  test(`compatibility: ${format} / ${transport} / ${kind}`, () => {
    const out = parseResponse(wrap(make(a)), tools)
    assert.equal(out.text,'')
    assert.equal(out.toolCalls.length,1)
    assert.equal(out.toolCalls[0]!.name,'pwsh')
    assert.deepEqual(JSON.parse(out.toolCalls[0]!.arguments),args)
    if(kind==='string') assert.equal(out.toolCalls[0]!.arguments,encoded)
  })
}

test('segmented JSON, per-part fences, tagged calls and text block order', () => {
  const text = JSON.stringify({text:'checking'})
  const calls = JSON.stringify({toolCalls:[call(args)]})
  for (const input of [text+'\n'+calls, '```json\n'+text+'\n```\n```json\n'+calls+'\n```',text+'\n```json\n'+calls+'\n```']) {
    const out=parseResponse(input,tools); assert.equal(out.text,'checking'); assert.equal(out.toolCalls.length,1)
  }
  assert.equal(parseResponse('<tool_call>'+JSON.stringify(call(args))+'</tool_call>\n<tool_call>'+JSON.stringify(call(args))+'</tool_call>',tools).toolCalls.length,2)
  assert.equal(parseResponse({content:[{type:'text',text:'a'},{type:'tool_use',name:'pwsh',input:args},{type:'text',text:'b'}]},tools).text,'a\n\nb')
  assert.equal(parseResponse({content:'final',tool_calls:null},tools).text,'final')
  assert.equal(parseResponse({content:null,refusal:'cannot do this'},tools).text,'cannot do this')
})

test('opaque text and explained examples never become executable fragments', () => {
  const wire=JSON.stringify({toolCalls:[call(args)]})
  for (const raw of ['Example: '+wire, '示例：\n```json\n'+wire+'\n```','Here: {"toolCalls":', '```ts\n'+wire+'\n```','DSML 是一种格式。']) {
    assert.deepEqual(parseResponse(raw,tools),{text:raw,toolCalls:[]})
  }
  for(const text of [wire,'<｜｜DSML｜｜ calls>','```json\n'+wire+'\n```']) {
    assert.deepEqual(parseResponse({text,toolCalls:[]},tools),{text,toolCalls:[]})
    assert.deepEqual(parseResponse(JSON.stringify({text,toolCalls:[]}),tools),{text,toolCalls:[]})
  }
})

test('reasoning metadata stays hidden and opaque delimiters survive framing', () => {
  assert.deepEqual(parseResponse({content:[{type:'thinking',thinking:'private',signature:'sig'},{type:'redacted_thinking',data:'opaque'},{type:'text',text:'answer'}]},tools),{text:'answer',toolCalls:[]})
  assert.deepEqual(parseResponse({parts:[{text:'private',thought:true},{text:'answer',thought:false,thoughtSignature:'sig'}]},tools),{text:'answer',toolCalls:[]})
  const text='Use ```ts fences and </tool_call> literally'
  assert.equal(parseResponse('```json\n'+JSON.stringify({text})+'\n```',tools).text,text)
  const wire=JSON.stringify(call({command:text}))
  assert.equal(JSON.parse(parseResponse('<tool_call>'+wire+'</tool_call>',tools).toolCalls[0]!.arguments).command,text)
})

test('Responses metadata and reasoning output normalize without leaking internal text', () => {
  const value={object:'response',status:'completed',instructions:null,tools:[],text:{format:{type:'text'}},reasoning:{effort:'high'},output:[
    {type:'reasoning',id:'rs-1',summary:[{type:'summary_text',text:'private'}],encrypted_content:'opaque'},
    {type:'message',id:'msg-1',role:'assistant',status:'completed',content:[{type:'output_text',text:'answer',annotations:[]}]},
  ]}
  assert.deepEqual(parseResponse(value,tools),{text:'answer',toolCalls:[]})
  assert.deepEqual(parseResponse({content:[{type:'refusal',refusal:'no'}]},tools),{text:'no',toolCalls:[]})
  assert.throws(()=>parseResponse([{type:'refusal',refusal:'no'},call(args)],tools))
})

test('array hooks, DSML duplicate keys and wrapper cycles fail without side effects', () => {
  let executed=0
  const hooked: unknown[]=[]
  Object.defineProperty(hooked,'toJSON',{value:()=>{executed++; return []}})
  const accessor:unknown[]=[]
  Object.defineProperty(accessor,'0',{get:()=>{executed++;return 1},enumerable:true})
  for(const a of [hooked,accessor]) assert.throws(()=>parseResponse({toolCalls:[call({a})]},tools))
  assert.equal(executed,0)
  for(const payload of ['{"x":1,"x":2}','{"x":1e400}']) {
    const dsml='<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="pwsh"><｜｜DSML｜｜ parameter name="x" string="false">'+payload+'</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>'
    assert.throws(()=>parseResponse(dsml,tools))
  }
  const cycle:Record<string,unknown>={};cycle.function=cycle
  assert.throws(()=>parseResponse(cycle,tools),/limit/)
})

const invalid: unknown[] = [
  {refusal:'no',content:[{type:'tool_use',name:'pwsh',input:{}}]},
  [{refusal:'no'},call(args)],
  {content:[{type:'tool_use',name:'pwsh',input:{}}],tool_calls:[fn(args)]},
  {type:'function_call',status:'in_progress',...call(args)},
  {parts:[{text:'bad',thought:'true'}]},
  {output:[call(args)],status:'incomplete'},
  '```json\n```json\n{}\n```\n```',
  {toolCalls:[call(args)],tool_calls:[]}, {text:'a',content:'b'},
  {toolCalls:[{...call(args),input:args}]}, {toolCalls:[{...call(args),extra:true}]},
  {toolCalls:[{name:'missing',arguments:args}]}, {toolCalls:[{name:'pwsh'}]},
  ...[null,[],42,'[]','null','undefined','{','{"a":1,"a":2}'].map(a=>({toolCalls:[call(a)]})),
  {content:[{type:'tool_result',content:'x'}]}, {parts:[{functionResponse:{name:'pwsh',response:{}}}]},
  {role:'user',content:'x'}, {role:'tool',content:'x'},
  {choices:[{message:{text:'a'}},{message:{text:'b'}}]},
  {choices:[{finish_reason:'length',message:{toolCalls:[call(args)]}}]},
  {candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'x'}]}}]},
  {tool_calls:[{type:'custom',function:call(args)}]},
  {tool_calls:[fn(args),fn(args)]}, {content:null,refusal:'no',tool_calls:[fn(args)]},
  {transcript:[{toolCalls:[call(args)]}]},
  {toolCalls:[call({value:undefined})]}, {toolCalls:[call({value:NaN})]},
  {toolCalls:[call({value:Infinity})]}, {toolCalls:[call(new Date())]},
  '{"text":"a","text":"b"}', '{"text":"a","te\\u0078t":"b"}',
  '{"toolCalls":[],"toolCalls":[]}',
  JSON.stringify({toolCalls:[call(args)]})+'\n{"toolCalls":',
  JSON.stringify({toolCalls:[call(args)]})+' trailing',
  '```json\n'+JSON.stringify({toolCalls:[call(args)]}),
  '<tool_call>'+JSON.stringify(call(args)),
  '<tool_call>'+JSON.stringify(call(args))+'</tool_call>trailing',
  '<function_call>unknown</function_call>',
]
test('all ambiguous, incomplete and non-data formats fail closed', () => {
  for(const v of invalid) assert.throws(()=>parseResponse(v,tools),JSON.stringify(v))
  const cyclic: Record<string,unknown>={};cyclic.self=cyclic
  assert.throws(()=>parseResponse({toolCalls:[call(cyclic)]},tools))
  assert.throws(()=>parseResponse({toolCalls:[call({toJSON(){throw Error('must not call')}})]},tools))
  const proto=JSON.parse('{"__proto__":{"polluted":true}}')
  assert.deepEqual(JSON.parse(parseResponse({toolCalls:[call(proto)]},tools).toolCalls[0]!.arguments),proto)
  assert.equal(Object.hasOwn(Object.prototype,'polluted'),false)
})

test('call/document/depth limits cover provider and string routes', () => {
  assert.equal(parseResponse({tool_calls:Array.from({length:32},()=>({type:'function',function:call(args)}))},tools).toolCalls.length,32)
  assert.throws(()=>parseResponse({toolCalls:Array.from({length:33},()=>call(args))},tools))
  assert.equal(parseResponse('{"text":"a"}'.repeat(64),tools).text.split('\n\n').length,64)
  assert.throws(()=>parseResponse('{"text":"a"}'.repeat(65),tools))
  assert.throws(()=>parseResponse('['.repeat(40)+'{}'+']'.repeat(40),tools))
})

async function replay(value: unknown, mode: 'structured'|'result'|'stream'): Promise<StreamChunk[]> {
  const runner: Runner=async function* (request) {
    assert.equal(request.tools,'');assert.equal(request.jsonSchema,undefined)
    yield {type:'usage',input:100,output:12,cacheRead:20,cacheWrite:0}
    if(mode==='structured') yield {type:'result',text:'',structuredOutput:value}
    else {
      const text=typeof value==='string'?value:JSON.stringify(value)
      if(mode==='result') yield {type:'result',text}
      else for(let i=0;i<text.length;i+=3) yield {type:'text',delta:text.slice(i,i+3)}
    }
  }
  const chunks:StreamChunk[]=[]
  for await(const c of new CodeBuddyAdapter(resolveConfig({},{}),runner).stream({provider:'codebuddy',model:'default',messages:[],tools})) chunks.push(c)
  return chunks
}
test('every provider format works through structuredOutput, result and fragmented stream', async()=>{
  for(const [,make] of cases) for(const mode of ['structured','result','stream'] as const) {
    const out=await replay(make(args),mode)
    assert.equal(out.filter(c=>c.type==='tool-call-delta').length,1)
    assert.equal(out.filter(c=>c.type==='finish').length,1)
    const last=out.at(-1);assert.equal(last?.type==='finish'&&last.reason.kind,'tool-calls')
  }
})
test('invalid trailing blocks emit no earlier text or tools and retain usage', async()=>{
  for(const value of invalid) {
    // Use arrays to place a valid call before every invalid structured member.
    const combined=typeof value==='string'?JSON.stringify({text:'checking',toolCalls:[call(args)]})+'\n'+value:[{text:'checking',toolCalls:[call(args)]},value]
    const out=await replay(combined,'structured')
    assert.equal(out.filter(c=>['text-delta','tool-call-delta','block-start'].includes(c.type)).length,0)
    assert.equal(out.filter(c=>c.type==='usage').length,1)
    assert.equal(out.filter(c=>c.type==='finish').length,1)
    const last=out.at(-1);assert.equal(last?.type==='finish'&&last.reason.kind,'error')
  }
})
