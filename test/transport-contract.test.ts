import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { buildPrompt, buildSystemPrompt, parseResponse, RESPONSE_CONTRACT } from '../src/prompt.ts'
import { CodeBuddyAdapter } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'
const tools=[{name:'read',description:'read',parameters:{}},{name:'workflow',description:'workflow',parameters:{}}]

test('historical arguments agree with object wire contract across repeated tool cycles without mutating history',()=>{
  const args={file_path:'汉字😀',nested:{script:'return `a ${JSON.stringify({x: "}"})}`;\n\\"'}}
  const history=Array.from({length:3},(_,i)=>({role:'assistant',content:[{type:'tool-call',id:`past${i}`,name:'read',arguments:JSON.stringify(args)}]})) as Message[]
  const before=JSON.stringify(history)
  const prompt=buildPrompt(history,tools,100000)
  const projected=JSON.parse(prompt.split('Conversation:\n')[1]!)
  for(const message of projected) assert.deepEqual(message.content[0].arguments,args)
  assert.equal(JSON.stringify(history),before)
  assert.ok(prompt.includes(RESPONSE_CONTRACT))
  assert.match(prompt,/No outer array/)
})

test('malformed historical arguments are retained as opaque data rather than repaired',()=>{
  for(const value of ['{}]','{"a":1,"a":2}','[1]']) {
    const history=[{role:'assistant',content:[{type:'tool-call',id:'past',name:'read',arguments:value}]}] as Message[]
    const prompt=buildPrompt(history,tools,100000)
    assert.equal(JSON.parse(prompt.split('Conversation:\n')[1]!).at(0).content[0].arguments,value)
  }
})

test('transport appendix preserves original system policy and leaves auxiliary calls unchanged',async()=>{
  const system='SYSTEM policy: preserve me verbatim. Native tool channels normally apply.'
  assert.equal(buildSystemPrompt(system,false),system)
  assert.equal(buildSystemPrompt(undefined,false),undefined)
  assert.equal(buildSystemPrompt(system,true),system+'\n\n'+RESPONSE_CONTRACT)
  for(const purpose of [undefined,'session-title'] as const) {
    const adapter=new CodeBuddyAdapter(resolveConfig({},{}),async function*(request){
      assert.equal(request.systemPrompt,purpose?system:buildSystemPrompt(system,true))
      assert.equal(request.tools,''); assert.equal(request.jsonSchema,undefined)
      yield {type:'result',text:purpose?'title':'{"type":"text","text":"done"}'}
    })
    for await(const chunk of adapter.stream({provider:'codebuddy',model:'default',system,purpose,messages:[],tools})) {
      if(chunk.type==='finish')assert.equal(chunk.reason.kind,'stop')
    }
  }
})

test('independent records preserve long nested script and arguments without outer-array bookkeeping',()=>{
  const args={script:'const x = `中文 ${JSON.stringify({x:"}"})}`;\nreturn x;'.repeat(100),meta:{name:'audit',description:'只读'},args:{cwd:'/project'},run_in_background:false}
  const raw=[{type:'text',text:'checking'},{type:'tool-call',name:'read',arguments:{file_path:'README.md'}},{type:'tool-call',name:'workflow',arguments:args}].map(v=>JSON.stringify(v)).join('\n')
  const parsed=parseResponse(raw,tools)
  assert.equal(parsed.text,'checking')
  assert.equal(parsed.toolCalls.length,2)
  assert.deepEqual(JSON.parse(parsed.toolCalls[1]!.arguments),args)
})

test('missing middle brace and extra workflow closing brace remain atomic failures visible through error channel',async()=>{
  const samples=[
    '{"text":"review","toolCalls":[{"name":"read","arguments":{"file_path":"a"}},{"name":"read","arguments":{"file_path":"b"},{"name":"read","arguments":{"file_path":"c"}}]}',
    '{"text":"review","toolCalls":[{"name":"read","arguments":{"file_path":"a"}},{"name":"workflow","arguments":{"meta":{"name":"audit"},"script":"return 1;"},"args":{"cwd":"/project"},"run_in_background":false}}]}',
    '{"type":"tool-call","name":"read","arguments":{"file_path":"a"}}\n{"type":"tool-call","name":"read","arguments":{"file_path":"b"}',
  ]
  for(const raw of samples){
    const chunks:StreamChunk[]=[]
    const adapter=new CodeBuddyAdapter(resolveConfig({},{}),async function*(){yield {type:'result',text:raw}})
    for await(const chunk of adapter.stream({provider:'codebuddy',model:'default',messages:[],tools}))chunks.push(chunk)
    assert.equal(chunks.filter(c=>c.type==='tool-call-delta').length,0)
    const finish=chunks.at(-1)
    assert.ok(finish?.type==='finish'&&finish.reason.kind==='error')
    assert.ok(finish.reason.failure?.message.includes(raw))
    assert.ok(chunks.filter(c=>c.type==='text-delta').map(c=>c.text).join('').includes(raw))
  }
})
