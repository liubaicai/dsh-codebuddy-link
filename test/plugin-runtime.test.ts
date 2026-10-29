import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, Message, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import type { CodeBuddyAdapter } from '../src/adapter.ts'
import type { RunSnapshot } from '../src/runtime.ts'
import type { WebServerLike } from '../src/web.ts'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done}); return {promise, resolve} }
const options: GenerateOptions = {provider:'codebuddy', model:'default', messages:[{id:'m1' as Message['id'],source:{kind:'user'},role:'user',content:[{type:'text',text:'ARGV'}]}]}
async function fixture(t: { after(fn: () => Promise<void>): void }, config: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'cb-integration-')), bin = join(home, 'cli.mjs')
  await writeFile(bin, `if(process.argv.includes('--acp')) {
  const {createInterface}=await import('node:readline');
  const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));
  for await(const line of createInterface({input:process.stdin})) {
    const row=JSON.parse(line);
    if(row.method==='initialize')send({id:row.id,result:{protocolVersion:1,agentCapabilities:{}}});
    if(row.method==='session/new')send({id:row.id,result:{sessionId:'fake-session'}});
    if(row.method==='session/prompt') {
      const hold=JSON.stringify(row.params.prompt).includes('HOLD');
      send({method:'session/update',params:{sessionId:'fake-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:hold?'ready':JSON.stringify(process.argv.slice(2))}}}});
      if(!hold)send({id:row.id,result:{stopReason:'end_turn'}});
    }
  }
} else {
let input = ''; for await (const chunk of process.stdin) input += chunk;
const send = x => console.log(JSON.stringify(x));
if(input.includes('HOLD')) { send({type:'assistant',message:{content:[{type:'text',text:'ready'}]}}); setInterval(()=>{},1000); }
else { send({type:'result',subtype:'success',result:JSON.stringify(process.argv.slice(2))}); }
}
`)
  let adapter!: CodeBuddyAdapter, tool: any, command: any
  const routes = new Map<string, Parameters<WebServerLike['register']>[0]['handler']>()
  const context = {
    llm: {registerAdapter: (_providers: string[], value: CodeBuddyAdapter) => {adapter = value}},
    tools: {register: (value: unknown) => {tool = value}},
    commands: {register: (value: unknown) => {command = value}},
    get: (name: string) => name === 'webServer' ? {register: (route: Parameters<WebServerLike['register']>[0]) => {routes.set(route.path, route.handler)}} : undefined,
    emit: () => {},
    inject: (_deps: string[], callback: (ctx: unknown) => void) => callback(context),
  }
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { apply(context as unknown as Context, {codebuddyBin:bin, workspaceRoot:home, timeoutMs:10000, maxConcurrency:1, reasoningEffort:'high', ...config}) }
  finally { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome }
  const server = createServer((req, res) => routes.get(req.url!)!(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, {recursive:true,force:true}) })
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/plugins/codebuddy-link/`
  const update = async (patch: unknown, expectedStatus = 200) => { const res = await fetch(base+'config', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(patch)}); assert.equal(res.status,expectedStatus); return res.json() }
  const runs = (): RunSnapshot[] => JSON.parse(command.handler({rawInput:'runs'}).text)
  const ask = (prompt: string, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<string> => tool.execute({prompt,...extra}, {signal})
  const model = async (extra: Partial<GenerateOptions> = {}, onText = () => {}) => {
    let text = ''; let finish: unknown
    for await (const event of adapter.stream({...options,...extra})) { if (event.type === 'text-delta') text += event.text; if (event.type === 'text-delta' || event.type === 'reasoning-delta') onText(); if (event.type === 'finish') finish = event.reason }
    return {text,finish}
  }
  return {tool,update,runs,ask,model}
}

test('provider always runs ACP; housekeeping and ask stay restricted print', async t => {
  const f=await fixture(t)
  await f.update({dangerouslySkipPermissions:true})
  const native=JSON.parse((await f.model()).text)
  assert.ok(native.includes('--acp')); assert.ok(!native.includes('--print'))
  assert.ok(native.includes('--dangerously-skip-permissions'))
  assert.equal(native[native.indexOf('--tools')+1],'default')
  for(const args of [JSON.parse((await f.model({purpose:'session-title'})).text),JSON.parse(await f.ask('ARGV'))]) {
    assert.ok(args.includes('--print')); assert.ok(!args.includes('--acp'))
    assert.ok(!args.includes('--dangerously-skip-permissions'))
    assert.equal(args[args.indexOf('--tools')+1],'')
  }
  // A stale page flipping the retired switch cannot downgrade the transport.
  await f.update({executionMode:'bridge'})
  assert.ok(JSON.parse((await f.model()).text).includes('--acp'))
  await f.update({dangerouslySkipPermissions:false})
  assert.ok(!JSON.parse((await f.model()).text).includes('--dangerously-skip-permissions'))
})

function effort(args: string[]): string | undefined { const at = args.indexOf('--effort'); return at < 0 ? undefined : args[at+1] }

test('actual provider and ask argv share effort inheritance, override and explicit auto', async t => {
  const f = await fixture(t, {queueTimeoutMs:60000})
  for (const [setting, expected] of [[undefined,'high'],['low','low'],['auto',undefined]] as const) {
    const extra = setting === undefined ? {} : {reasoningEffort:setting as ReasoningEffortId}
    assert.equal(effort(JSON.parse((await f.model(extra)).text)), expected)
    assert.equal(effort(JSON.parse(await f.ask('ARGV',extra))), expected)
  }
  const count = f.runs().length
  await assert.rejects(f.ask('ARGV',{reasoningEffort:'invalid'}),/Unsupported reasoning effort/)
  assert.equal(f.runs().length,count)
  await f.update({reasoningEffort:'max'})
  assert.equal(f.tool.timeoutMs,135000, 'host envelope covers both account and global queue budgets')
  assert.equal(effort(JSON.parse(await f.ask('ARGV'))),'max')
  assert.equal(effort(JSON.parse((await f.model()).text)),'max')
  await f.update({queueTimeoutMs:2147483647},400)
  assert.equal(f.tool.timeoutMs,135000, 'HTTP settings cannot change administrator queue budgets')
  const maximum = await fixture(t,{queueTimeoutMs:2147483647})
  assert.equal(maximum.tool.timeoutMs,2147483647)
})

test('registered provider and ask share queue; queued abort and active abort hand off slot', async t => {
  const f = await fixture(t), started = deferred(), stop = new AbortController(), queuedStop = new AbortController()
  const running = f.model({messages:[{id:'m1' as Message['id'],source:{kind:'user'},role:'user',content:[{type:'text',text:'HOLD'}]}],signal:stop.signal}, started.resolve)
  try {
    await started.promise
    const queued = f.ask('ARGV',{},queuedStop.signal)
    // Credential lookup is async, so wait for queue admission using event-loop turns.
    for (let i=0; i<100 && f.runs().length < 2; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.runs()[0]!.state,'queued')
    const rejected = assert.rejects(queued,{name:'AbortError'}); queuedStop.abort(); await rejected
    assert.equal(f.runs()[0]!.failure,'aborted')
    const next = f.ask('ARGV')
    stop.abort(); await running; assert.equal(f.runs().find(run => run.source==='model')?.state,'cancelled')
    assert.ok(JSON.parse(await next).includes('--print'))
    assert.equal(f.runs()[0]!.state,'completed')
  } finally {stop.abort(); await running}
})

test('panel cannot raise administrator concurrency or interrupt active and queued calls', async t => {
  const f = await fixture(t), started = deferred(), stop = new AbortController()
  const running = f.model({messages:[{id:'m1' as Message['id'],source:{kind:'user'},role:'user',content:[{type:'text',text:'HOLD'}]}],signal:stop.signal}, started.resolve)
  try {
    await started.promise
    const waiting = f.ask('ARGV')
    for (let i=0; i<100 && f.runs().length < 2; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.runs()[0]!.state,'queued')
    await f.update({maxConcurrency:2,stallWarnMs:0},400)
    assert.equal(f.runs()[0]!.state,'queued')
    assert.equal(f.runs().find(run => run.source==='model')?.state,'responding')
    stop.abort(); await running
    assert.ok(JSON.parse(await waiting).includes('--print'))
  } finally {stop.abort(); await running}
})

test('execution timeout frees shared slot and remains distinct from queue timeout', async t => {
  const f = await fixture(t,{timeoutMs:500,queueTimeoutMs:5000})
  const started = deferred()
  const running = f.model({messages:[{id:'m1' as Message['id'],source:{kind:'user'},role:'user',content:[{type:'text',text:'HOLD'}]}]},started.resolve)
  await started.promise
  const next = f.ask('ARGV')
  await running
  assert.equal(f.runs().find(run => run.source==='model')?.failure,'timeout')
  assert.ok(JSON.parse(await next).includes('--print'))
  assert.equal(f.runs()[0]!.state,'completed')
})
