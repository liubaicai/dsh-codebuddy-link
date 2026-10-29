import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { runCodeBuddyAcp } from '../src/acp.ts';
import type { BridgeEvent } from '../src/protocol.ts';

// This process speaks only ACP and deliberately keeps running after end_turn.
// Test traces prove both the RPC wire contract and subprocess termination.
const CLI = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
writeFileSync('server.pid', String(process.pid));
writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
const send = row => process.stdout.write(JSON.stringify(row) + '\n');
const reply = (id, result) => send({jsonrpc:'2.0',id,result});
const update = row => send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fresh-session',update:row}});
const text = value => update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:value}});
const input = createInterface({input:process.stdin});
let mode;
input.on('line', line => {
 const row = JSON.parse(line);
 appendFileSync('wire.ndjson', line + '\n');
 if (row.method === 'initialize') return reply(row.id,{protocolVersion:1,agentCapabilities:{loadSession:true}});
 if (row.method === 'session/new') { update({sessionUpdate:'config_option_update',configOptions:[]}); }
 if (row.method === 'session/new') return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:row.id,result:{sessionId:'fresh-session'}})+'\n'+JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fresh-session',update:{sessionUpdate:'available_commands_update',availableCommands:[]}}})+'\n');
 if (row.method === 'session/cancel') {writeFileSync('cancelled','yes'); if(mode==='orphan')process.exit(0); return;}
 if (!row.method) {
  if (mode === 'unknown') {text('not executed'); reply(3,{stopReason:'end_turn'});}
  return;
 }
 if (row.method !== 'session/prompt') return;
 mode = row.params.prompt[0].text;
 if (mode === 'error' || mode === 'auth') return send({jsonrpc:'2.0',id:row.id,error:{code:mode==='auth'?-32000:-32603,message:'SECRET_TOKEN https://private.invalid',data:{token:'SECRET_TOKEN'}}});
 if (mode === 'malformed') return process.stdout.write('SECRET_TOKEN not json\n');
 if (mode === 'oversized') return process.stdout.write('x'.repeat(8*1024*1024+1));
 if (mode === 'exit') {process.stderr.write('SECRET_TOKEN'); return process.exit(4);}
 if (mode === 'missing') return process.exit(0);
 if (mode === 'eof') return process.stdout.end();
 if (mode === 'bad-version') return send({jsonrpc:'1.0',id:row.id,result:{stopReason:'end_turn'}});
 if (mode === 'bad-id') return reply(99,{stopReason:'end_turn'});
 if (mode.startsWith('trailing:')) {
  const [,kind,grouping] = mode.split(':');
  const metadata = [
   {sessionUpdate:'session_info_update',title:'done',updatedAt:null},
   {sessionUpdate:'current_mode_update',currentModeId:'default'},
   {sessionUpdate:'config_option_update',configOptions:[{id:'model',name:'Model',type:'select',currentValue:'x',options:[{value:'x',name:'X'}]}]},
   {sessionUpdate:'available_commands_update',availableCommands:[{name:'help',description:'Help',input:{hint:'topic'}}]},
   {sessionUpdate:'usage_update',used:900,size:1000,_meta:{'codebuddy.ai/messageId':'billed',usage:{prompt_tokens:10,completion_tokens:5,prompt_cache_hit_tokens:2,prompt_cache_write_tokens:0},'codebuddy.ai/requestCredits':{r:0.25}}},
  ];
  const invalid = {
   text:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'SECRET_TOKEN'}},
   thought:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'SECRET_TOKEN'}},
   tool:{sessionUpdate:'tool_call',toolCallId:'late',status:'pending',rawInput:{command:'never execute'}},
   unknown:{sessionUpdate:'future_unverified_update'},
   shape:{sessionUpdate:'session_info_update',title:{secret:'SECRET_TOKEN'}},
   config:{sessionUpdate:'config_option_update',configOptions:[{}]},
   commands:{sessionUpdate:'available_commands_update',availableCommands:[{}]},
   usage:{sessionUpdate:'usage_update',used:'SECRET_TOKEN',size:1000},
  };
  const result={jsonrpc:'2.0',id:row.id,result:{stopReason:'end_turn'}};
  const tail = kind==='duplicate' ? [result] : kind==='request' ? [{jsonrpc:'2.0',id:'late-request',method:'terminal/create',params:{command:'never execute'}}] :
   (invalid[kind]?[invalid[kind]]:metadata).map(update=>({jsonrpc:'2.0',method:'session/update',params:{sessionId:kind==='wrong-id'?'wrong-session':'fresh-session',update}}));
  text('answer');
  const frame = value => JSON.stringify(value)+'\n';
  if(grouping==='split') {setTimeout(()=>process.stdout.write(frame(result)),10);setTimeout(()=>process.stdout.write(tail.map(frame).join('')),30);}
  else process.stdout.write([result,...tail].map(frame).join(''));
  return;
 }
 if (mode === 'late-update') return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:row.id,result:{stopReason:'end_turn'}})+'\n'+JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fresh-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'must not stream after end_turn'}}}})+'\n');
 if (mode === 'duplicate') {const result=JSON.stringify({jsonrpc:'2.0',id:row.id,result:{stopReason:'end_turn'}})+'\n'; return process.stdout.write(result+result);}
 if (mode === 'both') return send({jsonrpc:'2.0',id:row.id,result:{stopReason:'end_turn'},error:{code:0,message:'SECRET_TOKEN'}});
 if (mode === 'bad-update') return send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'wrong',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'SECRET_TOKEN'}}}});
 if (mode.startsWith('stop:')) return reply(row.id,{stopReason:mode.slice(5)});
 if (mode==='outcome')return reply(row.id,{stopReason:'end_turn',_meta:{'codebuddy.ai/outcome':'ERROR'}});
 if (mode === 'permission') return send({jsonrpc:'2.0',id:'permission-1',method:'session/request_permission',params:{sessionId:'fresh-session',toolCall:{toolCallId:'p',title:'SECRET_TOKEN HIGH CRITICAL'},options:[{optionId:'yes',name:'Allow',kind:'allow_once'}]}});
 if (mode === 'unknown') return send({jsonrpc:'2.0',id:'host-1',method:'terminal/create',params:{command:'must never execute'}});
 if (['hang','yield-tree','tree','orphan'].includes(mode)) {
  const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:mode==='orphan' && process.platform==='win32'});
  writeFileSync('child.pid', String(child.pid));
  if(mode === 'yield-tree' || mode === 'orphan') text('first');
  return;
 }
 if (mode === 'argv') {text(JSON.stringify(process.argv.slice(2))); return reply(row.id,{stopReason:'end_turn'});}
 if (mode === 'env') {text(process.env.CODEBUDDY_AUTH_TOKEN ?? 'ABSENT'); return reply(row.id,{stopReason:'end_turn'});}
 if(mode === 'messages') {
  text('ID-less prefix. ');
  update({sessionUpdate:'agent_message_chunk',messageId:'a',content:{type:'text',text:'First substantive finding. '}});
  update({sessionUpdate:'agent_message_chunk',_meta:{'codebuddy.ai/messageId':'b'},content:{type:'text',text:'Second'}});
  update({sessionUpdate:'agent_message_chunk',messageId:'b',content:{type:'text',text:' finding. '}});
  update({sessionUpdate:'agent_message_chunk',messageId:'a',content:{type:'text',text:'More first. '}});
  text('{"tool_calls":[{"name":"never_replay"}]}');
  return reply(row.id,{stopReason:'end_turn'});
 }
 if(mode === 'success-tree') {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:process.platform==='win32'});
  writeFileSync('child.pid',String(child.pid));text('done');return reply(row.id,{stopReason:'end_turn'});
 }
 if(mode.startsWith('progress:')) {
  const kind=mode.slice(9);let count=0;
  if(kind==='tool')update({sessionUpdate:'tool_call',toolCallId:'long-tool',status:'pending'});
  const tick=setInterval(()=>{
   count++;
   if(kind==='tool')update({sessionUpdate:'tool_call_update',toolCallId:'long-tool',status:'in_progress',rawOutput:'working '+count});
   else if(kind==='thought')update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'thinking'}});
   else text('working');
   if(count===12){clearInterval(tick);if(kind!=='stall')reply(row.id,{stopReason:'end_turn'});}
  },200);
  return;
 }
 if(mode==='noise') {
  setInterval(()=>{process.stderr.write('private diagnostic');text('');update({sessionUpdate:'session_info_update',title:'unchanged'});send({jsonrpc:'2.0',method:'unknown_notification'});},100);
  return;
 }
 if(mode === 'idle')return;
 update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'thinking'}});
 update({sessionUpdate:'tool_call',toolCallId:'native-1',title:'Read',kind:'read',status:'pending',rawInput:{path:'a'}});
 update({sessionUpdate:'tool_call_update',toolCallId:'native-1',status:'in_progress'});
 update({sessionUpdate:'tool_call_update',toolCallId:'native-1',status:'completed',rawOutput:'contents'});
 update({sessionUpdate:'tool_call_update',toolCallId:'native-1',status:'completed',rawOutput:'duplicate'});
 // These fields are NOT token usage. Do not invent consumption from them.
 update({sessionUpdate:'usage_update',used:25,size:100000,cost:{amount:0.1,currency:'USD'}});
 text('中文😀'); text(' done');
 reply(row.id,{stopReason:'end_turn'});
});
setInterval(()=>{},1000);
`;

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), 'codebuddy acp '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = join(cwd, 'fake acp.mjs');
  await writeFile(bin, CLI);
  return { cwd, bin, timeoutMs: 10000 };
}
async function collect(iterator: AsyncIterable<BridgeEvent>): Promise<BridgeEvent[]> {
  const events: BridgeEvent[] = []; for await (const event of iterator) events.push(event); return events;
}
async function wire(cwd: string): Promise<{ id?: string | number; method?: string; result?: { outcome?: { outcome?: string; optionId?: string } } }[]> {
  return (await readFile(join(cwd, 'wire.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
async function dead(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(20);
  }
  assert.fail(`process ${pid} survived cleanup`);
}
async function waitFile(path: string): Promise<string> {
  for (let i = 0; i < 150; i++) {
    try { return await readFile(path, 'utf8'); } catch { await delay(20); }
  }
  assert.fail(`missing fixture file ${path}`);
}

test('ACP v1 initializes with no host capabilities, creates fresh session, sends complete history and maps native events', async t => {
  const f = await fixture(t);
  let spawned = 0;
  const events = await collect(runCodeBuddyAcp({ ...f, prompt: 'complete history\nuser and assistant', onSpawn: () => { spawned++; } }));
  assert.equal(spawned, 1);
  const rows = await wire(f.cwd);
  assert.deepEqual(rows[0], { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
  assert.deepEqual(rows[1], { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: f.cwd, mcpServers: [] } });
  assert.deepEqual(rows[2], { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'fresh-session', prompt: [{ type: 'text', text: 'complete history\nuser and assistant' }] } });
  assert.deepEqual(events, [
    { type: 'reasoning', delta: 'thinking' },
    { type: 'tool-start', id: 'native-1', name: 'Read', input: { path: 'a' } },
    { type: 'tool-end', id: 'native-1', name: 'Read', output: 'contents', isError: false },
    { type: 'text', delta: '中文😀' }, { type: 'text', delta: ' done' },
    { type: 'result', sessionId: 'fresh-session', text: '中文😀 done' },
  ]);
  await dead(Number(await readFile(join(f.cwd, 'server.pid'), 'utf8')));
});

test('ACP preserves every message part and ID-less prefix without inventing finality or replaying opaque text', async t => {
 const f=await fixture(t);const events=await collect(runCodeBuddyAcp({...f,prompt:'messages'}));
 const parts=['ID-less prefix. ','First substantive finding. ','Second',' finding. ','More first. ','{"tool_calls":[{"name":"never_replay"}]}'];
 assert.deepEqual(events.flatMap(e=>e.type==='text'?[e.delta]:[]),parts);
 assert.deepEqual(events.at(-1),{type:'result',sessionId:'fresh-session',text:parts.join('')});
 assert.equal(events.some(e=>e.type==='tool-start'||e.type==='tool-end'),false);
 assert.deepEqual((await wire(f.cwd)).map(row=>row.method),['initialize','session/new','session/prompt']);
});

test('post-result session metadata and billing are accepted together or across stdout reads', {timeout:30000}, async t => {
 for(const grouping of ['joined','split']) {
  const f=await fixture(t);const events:BridgeEvent[]=[];
  for await(const event of runCodeBuddyAcp({...f,prompt:`trailing:valid:${grouping}`})) {
   events.push(event);
   // POSIX cleanup is synchronous; hold a text yield so split frames are read
   // before the completion boundary. Windows also covers reads during capture.
   if(grouping==='split' && process.platform!=='win32' && event.type==='text')await delay(100);
  }
  assert.deepEqual(events,[{type:'text',delta:'answer'},{type:'usage',input:10,output:5,cacheRead:2,cacheWrite:0},{type:'metadata',totalCredits:0.25},{type:'result',sessionId:'fresh-session',text:'answer'}]);
 }
});

test('post-result text, execution, unknown updates, wrong sessions, bad metadata and duplicate RPC fail closed', {timeout:90000}, async t => {
 for(const kind of ['text','thought','tool','unknown','wrong-id','shape','config','commands','usage','duplicate','request']) {
  for(const grouping of ['joined',...(process.platform==='win32'?['split']:[])]) {
   const f=await fixture(t);const events:BridgeEvent[]=[];
   await assert.rejects(async()=>{for await(const event of runCodeBuddyAcp({...f,prompt:`trailing:${kind}:${grouping}`}))events.push(event);},error=>error instanceof Error && !error.message.includes('SECRET_TOKEN'),`${kind}:${grouping}`);
   assert.equal(events.some(e=>e.type==='result'||e.type==='tool-start'),false);
   assert.equal((await wire(f.cwd)).some(row=>row.id==='late-request'),false);
  }
 }
});

test('successful completion still captures and kills native descendants', {timeout:20000}, async t => {
 const f=await fixture(t);const events=await collect(runCodeBuddyAcp({...f,prompt:'success-tree'}));
 assert.deepEqual(events.at(-1),{type:'result',sessionId:'fresh-session',text:'done'});
 await dead(Number(await readFile(join(f.cwd,'child.pid'),'utf8')));
 await dead(Number(await readFile(join(f.cwd,'server.pid'),'utf8')));
});

test('cleanup capture failure preserves primary auth, abort, timeout and protocol errors, but rejects success', {skip:process.platform!=='win32',timeout:30000}, async t => {
 const original=process.env.SystemRoot;
 const restore=()=>{if(original===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=original;};
 const onSpawn=()=>{process.env.SystemRoot='Z:\\missing-SECRET_TOKEN-private-root';};
 try {
  for(const [prompt,name,pattern] of [
   ['auth','CodeBuddyAuthError',/requires authorization/],
   ['error','Error',/server error details omitted/],
   ['malformed','Error',/Invalid or oversized/],
   ['idle','TimeoutError',/timed out/],
   ['env','Error',/descendant capture failed/],
  ] as const) {
   restore();
   const f=await fixture(t);const events:BridgeEvent[]=[];
   await assert.rejects(async()=>{for await(const event of runCodeBuddyAcp({...f,prompt,onSpawn,timeoutMs:prompt==='idle'?1000:10000}))events.push(event);},error=>{
    assert.ok(error instanceof Error);assert.equal(error.name,name,error.message);assert.match(error.message,pattern);
    assert.doesNotMatch(error.message,/SECRET_TOKEN|private-root|private\.invalid/);
    if(prompt!=='env') {
     assert.match(error.message,/secondary cleanup failure: CodeBuddy ACP descendant capture failed/);
     assert.equal((error as Error & {cleanupError?:Error}).cleanupError?.message,'CodeBuddy ACP descendant capture failed; cleanup could not be verified');
    }
    return true;
   });
   assert.equal(events.some(e=>e.type==='result'),false);
   await dead(Number(await readFile(join(f.cwd,'server.pid'),'utf8')));
  }
  restore();
  const f=await fixture(t);const controller=new AbortController();
  const outcome=collect(runCodeBuddyAcp({...f,prompt:'idle',onSpawn,signal:controller.signal})).catch(error=>error);
  await waitFile(join(f.cwd,'server.pid'));controller.abort();
  const error=await outcome;
  assert.equal(error.name,'AbortError');assert.match(error.message,/request aborted; secondary cleanup failure/);
  assert.doesNotMatch(error.message,/SECRET_TOKEN|private-root/);
  await dead(Number(await readFile(join(f.cwd,'server.pid'),'utf8')));
 } finally {
  if(original===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=original;
 }
});

test('ACP argv uses stdio native default tools and optional literal values without permission conflicts', async t => {
  const f = await fixture(t);
  const literal = 'literal & | " $ ()';
  await collect(runCodeBuddyAcp({ ...f, prompt: 'argv', model: 'native-model', effort: 'high', appendSystemPrompt: literal, dangerouslySkipPermissions: true }));
  const args: string[] = JSON.parse(await readFile(join(f.cwd, 'argv.json'), 'utf8'));
  assert.deepEqual(args, ['--acp', '--acp-transport', 'stdio', '--tools', 'default', '--no-session-persistence', '--dangerously-skip-permissions', '--append-system-prompt', literal, '--model', 'native-model', '--effort', 'high']);
  for (const forbidden of ['--resume', '--continue', '--print', '--permission-mode']) assert.ok(!args.includes(forbidden));
  await collect(runCodeBuddyAcp({ ...f, prompt: 'argv', permissionMode: 'plan' }));
  const normal: string[] = JSON.parse(await readFile(join(f.cwd, 'argv.json'), 'utf8'));
  assert.equal(normal[normal.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(!normal.includes('--dangerously-skip-permissions'));
});

test('ACP inherits authentication through childEnv', async t => {
  const f = await fixture(t);
  const events = await collect(runCodeBuddyAcp({ ...f, prompt: 'env', authToken: 'test-token' }));
  assert.equal(events.at(-1)?.type === 'result' ? (events.at(-1) as { text: string }).text : undefined, 'test-token');
});

test('permission requests fail closed even with explicit bypass and emit cancelled outcome before cleanup', async t => {
  for (const dangerouslySkipPermissions of [false, true]) {
    const f = await fixture(t);
    await assert.rejects(collect(runCodeBuddyAcp({ ...f, prompt: 'permission', dangerouslySkipPermissions })), error => error instanceof Error && /permission request cancelled/.test(error.message) && !error.message.includes('SECRET_TOKEN'));
    const rows = await wire(f.cwd);
    assert.ok(rows.some(row => row.id === 'permission-1' && row.result?.outcome?.outcome === 'cancelled'));
    assert.ok(rows.some(row => row.method === 'session/cancel'));
    assert.equal(rows.some(row => row.result?.outcome?.optionId === 'yes'), false);
    await dead(Number(await readFile(join(f.cwd, 'server.pid'), 'utf8')));
  }
});

test('unsupported host requests return method-not-found and are never replayed', async t => {
  const f = await fixture(t);
  const events = await collect(runCodeBuddyAcp({ ...f, prompt: 'unknown' }));
  assert.deepEqual((await wire(f.cwd)).find(row => row.id === 'host-1'), { jsonrpc: '2.0', id: 'host-1', error: { code: -32601, message: 'Method not found' } });
  assert.deepEqual(events.at(-1), { type: 'result', sessionId: 'fresh-session', text: 'not executed' });
});

test('server errors, malformed frames, invalid RPC, oversized frames and early exits reject without server secrets', async t => {
  for (const prompt of ['error', 'malformed', 'oversized', 'exit', 'missing', 'eof', 'bad-version', 'bad-id', 'both', 'bad-update', 'late-update', 'duplicate', 'outcome']) {
    const f = await fixture(t);
    await assert.rejects(collect(runCodeBuddyAcp({ ...f, prompt })), error => error instanceof Error && !/SECRET_TOKEN|private\.invalid/.test(error.message), prompt);
    await dead(Number(await readFile(join(f.cwd, 'server.pid'), 'utf8')));
  }
});

test('non-end_turn stop reasons are never silent success', async t => {
  const f = await fixture(t);
  for (const reason of ['cancelled', 'refusal', 'max_tokens', 'max_turn_requests', 'SECRET_TOKEN']) {
    const events: BridgeEvent[] = [];
    await assert.rejects((async () => { for await (const event of runCodeBuddyAcp({ ...f, prompt: `stop:${reason}` })) events.push(event); })(), error => error instanceof Error && !error.message.includes('SECRET_TOKEN'));
    assert.ok(!events.some(event => event.type === 'result'));
  }
});

test('pre-abort and invalid inputs fail before spawn', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collect(runCodeBuddyAcp({ ...f, prompt: 'hang', signal: controller.signal })), { name: 'AbortError' });
  for (const timeoutMs of [0, -1, Infinity, NaN]) await assert.rejects(collect(runCodeBuddyAcp({ ...f, prompt: 'hang', timeoutMs })), RangeError);
  await assert.rejects(collect(runCodeBuddyAcp({ ...f, prompt: 'hang', jsonSchema: {} })), /not supported/);
  await assert.rejects(readFile(join(f.cwd, 'server.pid')), { code: 'ENOENT' });
});

test('active cancellation sends session/cancel, kills process tree and removes signal listeners', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const outcome = collect(runCodeBuddyAcp({ ...f, prompt: 'tree', signal: controller.signal })).catch(error => error);
  const pid = Number(await waitFile(join(f.cwd, 'child.pid')));
  controller.abort();
  assert.equal((await outcome).name, 'AbortError');
  assert.equal(await readFile(join(f.cwd, 'cancelled'), 'utf8'), 'yes');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await dead(pid);
  await dead(Number(await readFile(join(f.cwd, 'server.pid'), 'utf8')));
});

test('ACP progress renews the idle budget for text, thoughts and in-progress tools', {timeout:30000}, async t => {
  for (const kind of ['text','thought','tool']) {
    const f = await fixture(t);
    const start = Date.now();
    const events = await collect(runCodeBuddyAcp({...f,prompt:`progress:${kind}`,timeoutMs:1500}));
    assert.ok(Date.now()-start > 1500, 'task must outlive the old total deadline');
    const result = events.at(-1);
    assert.equal(result?.type, 'result');
    if (kind==='text') assert.equal(result?.type==='result' && result.text, 'working'.repeat(12));
    await dead(Number(await readFile(join(f.cwd,'server.pid'),'utf8')));
  }
});

test('ACP times out after progress stops, not from the original start time', {timeout:15000}, async t => {
  const f = await fixture(t);
  let chunks = 0;
  let lastProgress = 0;
  await assert.rejects(async () => {
    for await (const event of runCodeBuddyAcp({...f,prompt:'progress:stall',timeoutMs:1500})) {
      if (event.type==='text') { chunks++; lastProgress=Date.now(); }
    }
  }, {name:'TimeoutError',message:'CodeBuddy ACP request timed out after 1500ms without progress'});
  assert.equal(chunks,12);
  assert.ok(Date.now()-lastProgress >= 1400);
  assert.equal(await readFile(join(f.cwd,'cancelled'),'utf8'),'yes');
  await dead(Number(await readFile(join(f.cwd,'server.pid'),'utf8')));
});

test('stderr, empty text and unrelated metadata do not renew the ACP idle budget', {timeout:15000}, async t => {
  const f = await fixture(t);
  await assert.rejects(collect(runCodeBuddyAcp({...f,prompt:'noise',timeoutMs:1500})), {name:'TimeoutError'});
  await dead(Number(await readFile(join(f.cwd,'server.pid'),'utf8')));
});

test('ACP completion stops the idle watchdog while the consumer holds a streamed event', {timeout:15000}, async t => {
  const f = await fixture(t);
  const events: BridgeEvent[] = [];
  let held = false;
  for await (const event of runCodeBuddyAcp({...f,prompt:'messages',timeoutMs:1500})) {
    events.push(event);
    if (!held && event.type==='text') { held=true; await delay(2200); }
  }
  assert.ok(held);
  assert.equal(events.at(-1)?.type,'result');
});

test('explicit cancellation still stops an ACP task with ongoing progress', {timeout:15000}, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(async () => {
    for await (const event of runCodeBuddyAcp({...f,prompt:'progress:text',timeoutMs:1500,signal:controller.signal})) {
      if (event.type==='text') controller.abort();
    }
  }, {name:'AbortError'});
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
  assert.equal(await readFile(join(f.cwd,'cancelled'),'utf8'),'yes');
  await dead(Number(await readFile(join(f.cwd,'server.pid'),'utf8')));
});

test('timeout sends cancellation and cleans up the process tree', async t => {
  const f = await fixture(t);
  await assert.rejects(collect(runCodeBuddyAcp({ ...f, prompt: 'hang', timeoutMs: 1500 })), { name: 'TimeoutError' });
  assert.equal(await readFile(join(f.cwd, 'cancelled'), 'utf8'), 'yes');
  await dead(Number(await readFile(join(f.cwd, 'child.pid'), 'utf8')));
});

test('cancellation cleans descendants even when parent exits on cancel', async t => {
 const f=await fixture(t);const controller=new AbortController();
 await assert.rejects(async()=>{for await(const e of runCodeBuddyAcp({...f,prompt:'orphan',signal:controller.signal})) { if(e.type==='text')controller.abort(); }},{name:'AbortError'});
 assert.equal(await readFile(join(f.cwd,'cancelled'),'utf8'),'yes');
 await dead(Number(await readFile(join(f.cwd,'child.pid'),'utf8')));
 await dead(Number(await readFile(join(f.cwd,'server.pid'),'utf8')));
});

test('holding final result retains no abort listener or running subprocess', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const iterator = runCodeBuddyAcp({ ...f, prompt: 'env', signal: controller.signal });
  while (true) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (next.value?.type === 'result') break;
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await dead(Number(await readFile(join(f.cwd, 'server.pid'), 'utf8')));
  await iterator.return(undefined);
});

test('consumer early return cancels native work and kills descendants', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  for await (const event of runCodeBuddyAcp({ ...f, prompt: 'yield-tree', signal: controller.signal })) {
    assert.deepEqual(event, { type: 'text', delta: 'first' });
    break;
  }
  assert.equal(await readFile(join(f.cwd, 'cancelled'), 'utf8'), 'yes');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await dead(Number(await readFile(join(f.cwd, 'child.pid'), 'utf8')));
  await dead(Number(await readFile(join(f.cwd, 'server.pid'), 'utf8')));
});
