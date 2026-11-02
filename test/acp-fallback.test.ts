import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodeBuddyAcp } from '../src/acp.ts';
import { CodeBuddyLimitError } from '../src/acp-error.ts';
import type { BridgeEvent } from '../src/protocol.ts';

async function fixture(t: TestContext, mode = 'chain') {
  const cwd = await mkdtemp(join(tmpdir(), 'codebuddy-fallback-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = join(cwd, 'server.cjs');
  await writeFile(bin, `
const fs = require('node:fs'), readline = require('node:readline');
const mode = ${JSON.stringify(mode)};
if (Object.keys(process.env).some(key => key.toUpperCase()==='CODEBUDDY_JOB_ID')) throw new Error('Inherited native job identity');
let model = 'primary';
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
const reply = (id, result) => emit({jsonrpc:'2.0',id,result});
const update = row => emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'same-session',update:row}});
const quota = {code:-32003,message:'quota_token_limit',data:{category:'quota',statusCode:429}};
readline.createInterface({input:process.stdin}).on('line', line => {
  const row = JSON.parse(line);
  fs.appendFileSync('wire.jsonl', JSON.stringify(row)+'\\n');
  if(row.method==='initialize') return reply(row.id,{protocolVersion:1,agentCapabilities:{}});
  if(row.method==='session/new') return reply(row.id,{sessionId:'same-session',models:{currentModelId:'primary'}});
  if(row.method==='session/set_model') {
    fs.writeFileSync('switch-started','1');
    if(mode==='hold-switch') return;
    model=row.params.modelId;
    update({sessionUpdate:'config_option_update',configOptions:[{id:'model',name:'Model',type:'select',currentValue:model,options:[{value:model,name:model}]}]});
    reply(row.id,{modelId:mode==='wrong-model'?'unexpected':model});
    update({sessionUpdate:'usage_update',used:0,size:128000});
    return;
  }
  if(row.method!=='session/prompt') return;
  const original = row.params.prompt[0].text==='ORIGINAL TASK';
  if(original) {
    fs.appendFileSync('effects','once\\n');
    update({sessionUpdate:'tool_call',toolCallId:'edit-1',title:'Edit',status:'in_progress'});
    update({sessionUpdate:'tool_call_update',toolCallId:'edit-1',status:'completed'});
  }
  update({sessionUpdate:'usage_update',_meta:{'codebuddy.ai/messageId':model,usage:{prompt_tokens:10,completion_tokens:5,prompt_cache_hit_tokens:0,prompt_cache_write_tokens:0}}});
  if(mode==='auth') return emit({jsonrpc:'2.0',id:row.id,error:{...quota,code:-32000}});
  if(mode==='ambiguous') return emit({jsonrpc:'2.0',id:row.id,error:{code:-32603,message:'internal failure, request id 429'}});
  if(mode==='native-cancel') return reply(row.id,{stopReason:'cancelled',_meta:{'codebuddy.ai/outcome':'CANCELLED','codebuddy.ai/errorMessage':JSON.stringify(quota)}});
  if(mode==='rpc' && original) return emit({jsonrpc:'2.0',id:row.id,error:quota});
  const done = model==='winner' || mode==='recovered' || mode==='partial';
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:done?'最终答案':'未完成的草稿'}});
  const error = mode==='credits'?{...quota,message:'余额不足',data:{category:'quota',statusCode:402}}:quota;
  reply(row.id,{stopReason:done?'end_turn':'refusal',_meta:{'codebuddy.ai/outcome':mode==='partial'?'PARTIAL_SUCCESS':done?'SUCCESS':'FAILED_MODEL_REQUEST','codebuddy.ai/errorMessage':JSON.stringify(error)}});
});
`);
  return { cwd, bin, prompt: 'ORIGINAL TASK', model: 'primary', timeoutMs: 5000, signal: t.signal };
}
async function wire(cwd: string): Promise<any[]> {
  return (await readFile(join(cwd, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
async function collect(source: AsyncIterable<BridgeEvent>) { const rows: BridgeEvent[] = []; for await (const row of source) rows.push(row); return rows; }
async function waitForSwitch(cwd: string) {
  for (let i = 0; i < 200; i++) {
    try { await readFile(join(cwd,'switch-started')); return; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  throw new Error('Fake ACP did not receive set_model');
}

test('429 candidates keep one native session, preserve order, and continue without replaying the original task', {timeout:30000}, async t => {
  const previousJob = process.env.CODEBUDDY_JOB_ID;
  process.env.CODEBUDDY_JOB_ID = 'parent-native-job';
  t.after(() => { if(previousJob === undefined) delete process.env.CODEBUDDY_JOB_ID; else process.env.CODEBUDDY_JOB_ID = previousJob; });
  for (const mode of ['chain','rpc']) {
    const f = await fixture(t,mode);
    const events = await collect(runCodeBuddyAcp({...f,fallbackModels:['primary','backup','backup','winner']}));
    const rows = await wire(f.cwd);
    assert.equal(process.env.CODEBUDDY_JOB_ID,'parent-native-job');
    assert.equal(rows.filter(row => row.method==='initialize').length,1);
    assert.equal(rows.filter(row => row.method==='session/new').length,1);
    assert.deepEqual(rows.filter(row => row.method==='session/set_model').map(row => row.params.modelId),['backup','winner']);
    const prompts = rows.filter(row => row.method==='session/prompt');
    assert.equal(prompts.length,3);
    assert.equal(prompts[0].params.prompt[0].text,'ORIGINAL TASK');
    assert.ok(prompts.slice(1).every(row => row.params.sessionId==='same-session' && /继续尚未完成/.test(row.params.prompt[0].text) && !row.params.prompt[0].text.includes('ORIGINAL TASK')));
    assert.equal(await readFile(join(f.cwd,'effects'),'utf8'),'once\n');
    assert.deepEqual(events.filter(row => row.type==='model-switch').map(row => row.model),['backup','winner']);
    assert.equal(events.filter(row => row.type==='result').length,1);
    assert.deepEqual(events.at(-1),{type:'result',sessionId:'same-session',text:'最终答案'});
    assert.deepEqual(events.filter(row => row.type==='usage').at(-1),{type:'usage',input:30,output:15,cacheRead:0,cacheWrite:0});
  }
});

test('empty candidates and exhausted candidates retain the actionable terminal error', {timeout:30000}, async t => {
  for (const candidates of [[], ['backup','primary','backup','last']]) {
    const f = await fixture(t);
    await assert.rejects(collect(runCodeBuddyAcp({...f,fallbackModels:candidates})), (error: unknown) => {
      assert.ok(error instanceof CodeBuddyLimitError);
      assert.equal(error.status,429);
      assert.match(error.message,/HTTP 429/);
      if(candidates.length) assert.match(error.message,/已尝试所有候选模型/);
      return true;
    });
    const rows=await wire(f.cwd);
    assert.equal(rows.filter(row=>row.method==='session/prompt').length,candidates.length?3:1);
    assert.equal(rows.filter(row=>row.method==='session/set_model').length,candidates.length?2:0);
  }
});

test('non-429, authentication and completed outcomes never activate candidates', {timeout:60000}, async t => {
  for (const mode of ['credits','auth','ambiguous','native-cancel','recovered','partial']) {
    const f = await fixture(t,mode);
    const run=collect(runCodeBuddyAcp({...f,fallbackModels:['winner']}));
    if(mode==='credits') await assert.rejects(run, (error: unknown) => error instanceof CodeBuddyLimitError && error.status===402);
    else if(mode==='auth') await assert.rejects(run, {name:'CodeBuddyAuthError'});
    else if(mode==='ambiguous') await assert.rejects(run, /request failed/);
    else if(mode==='native-cancel') await assert.rejects(run, {name:'AbortError'});
    else assert.equal((await run).at(-1)?.type,'result');
    assert.equal((await wire(f.cwd)).filter(row=>row.method==='session/set_model').length,0);
  }
});

test('switch confirmation, cancellation and idle timeout stop continuation safely', {timeout:30000}, async t => {
  const mismatch = await fixture(t,'wrong-model');
  await assert.rejects(collect(runCodeBuddyAcp({...mismatch,fallbackModels:['winner']})),/未确认候选模型切换/);
  assert.equal((await wire(mismatch.cwd)).filter(row=>row.method==='session/prompt').length,1);
  const cancelled = await fixture(t,'hold-switch');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stopped = assert.rejects(collect(runCodeBuddyAcp({...cancelled,fallbackModels:['winner'],signal:controller.signal})),{name:'AbortError'});
  await waitForSwitch(cancelled.cwd);
  controller.abort();
  await stopped;
  assert.equal((await wire(cancelled.cwd)).filter(row=>row.method==='session/prompt').length,1);
  const timed = await fixture(t,'hold-switch');
  await assert.rejects(collect(runCodeBuddyAcp({...timed,timeoutMs:2000,fallbackModels:['winner']})),{name:'TimeoutError'});
  const rows = await wire(timed.cwd);
  assert.equal(rows.filter(row=>row.method==='session/set_model').length,1);
  assert.equal(rows.filter(row=>row.method==='session/prompt').length,1);
});
