import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { autonomousSystemPrompt, buildPrompt, buildSystemPrompt, parseResponse, RESPONSE_CONTRACT } from '../src/prompt.ts'
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

test('standalone transport appendix preserves original system policy',()=>{
  const system='SYSTEM policy: preserve me verbatim. Native tool channels normally apply.'
  assert.equal(buildSystemPrompt(system,false),system)
  assert.equal(buildSystemPrompt(undefined,false),undefined)
  assert.equal(buildSystemPrompt(system,true),system+'\n\n'+RESPONSE_CONTRACT)
})

test('ordinary calls append autonomous context while auxiliary calls stay restricted and unstructured',async()=>{
  const system='SYSTEM policy: preserve me verbatim. Native tool channels normally apply.'
  for(const purpose of [undefined,'session-title'] as const) {
    const expected=purpose?'title':'{"type":"text","text":"done"}'
    const cfg=resolveConfig({workspaceRoot:process.cwd(),permissionMode:'acceptEdits',dangerouslySkipPermissions:true},{})
    let invoked=false
    const adapter=new CodeBuddyAdapter(cfg,async function*(request){
      invoked=true
      assert.equal(request.cwd,process.cwd())
      assert.equal(request.systemPrompt,purpose?system:undefined)
      assert.equal(request.appendSystemPrompt,purpose?undefined:autonomousSystemPrompt(system))
      assert.equal(request.permissionMode,purpose?'dontAsk':'acceptEdits')
      assert.equal(request.dangerouslySkipPermissions,purpose?undefined:true)
      assert.equal(request.tools,purpose?'':'default')
      assert.equal(request.jsonSchema,undefined)
      assert.doesNotMatch(request.prompt,/DSH transport contract|Available DSH tools:/)
      assert.equal(request.prompt,buildPrompt([],[],cfg.maxPromptChars,!purpose))
      yield {type:'result',text:expected}
    })
    const chunks:StreamChunk[]=[]
    for await(const chunk of adapter.stream({provider:'codebuddy',model:'default',system,purpose,messages:[],tools})) chunks.push(chunk)
    assert.equal(invoked,true)
    assert.deepEqual(chunks.filter(c=>c.type==='text-delta').map(c=>c.text),[expected])
    assert.equal(chunks.filter(c=>c.type==='tool-call-delta'||c.type==='block-start'&&c.blockType==='tool-call').length,0)
    assert.equal(chunks.filter(c=>c.type==='finish').length,1)
    const finish=chunks.at(-1)
    assert.equal(finish?.type==='finish'&&finish.reason.kind,'stop')
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

test('malformed envelopes still fail the standalone parser but remain ordinary ACP final text',async()=>{
  const samples=[
    '{"text":"review","toolCalls":[{"name":"read","arguments":{"file_path":"a"}},{"name":"read","arguments":{"file_path":"b"},{"name":"read","arguments":{"file_path":"c"}}]}',
    '{"text":"review","toolCalls":[{"name":"read","arguments":{"file_path":"a"}},{"name":"workflow","arguments":{"meta":{"name":"audit"},"script":"return 1;"},"args":{"cwd":"/project"},"run_in_background":false}}]}',
    '{"type":"tool-call","name":"read","arguments":{"file_path":"a"}}\n{"type":"tool-call","name":"read","arguments":{"file_path":"b"}',
  ]
  for(const raw of samples){
    assert.throws(()=>parseResponse(raw,tools))
    const chunks:StreamChunk[]=[]
    const adapter=new CodeBuddyAdapter(resolveConfig({workspaceRoot:process.cwd()},{}),async function*(){yield {type:'result',text:raw}})
    for await(const chunk of adapter.stream({provider:'codebuddy',model:'default',messages:[],tools}))chunks.push(chunk)
    assert.equal(chunks.filter(c=>c.type==='tool-call-delta'||c.type==='block-start'&&c.blockType==='tool-call').length,0)
    assert.equal(chunks.filter(c=>c.type==='finish').length,1)
    const finish=chunks.at(-1)
    assert.ok(finish?.type==='finish'&&finish.reason.kind==='stop')
    assert.deepEqual(chunks.filter(c=>c.type==='text-delta').map(c=>c.text),[raw])
  }
})
