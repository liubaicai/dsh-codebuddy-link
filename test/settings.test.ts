import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { SettingsStore } from '../src/settings.ts'
import { CODEBUDDY_EFFORTS, isCodeBuddyEffort, resolveConfig } from '../src/config.ts'
import { registerSettingsRoutes, type WebServerLike } from '../src/web.ts'
import { CodeBuddyAdapter } from '../src/adapter.ts'

test('runtime settings validate defaults, environment, efforts and numeric boundaries', () => {
  const defaults = resolveConfig({}, {})
  assert.equal(defaults.reasoningEffort, 'auto'); assert.equal(defaults.maxConcurrency, 2)
  assert.equal(defaults.queueTimeoutMs, 600000); assert.equal(defaults.stallWarnMs, 90000)
  const env = {DSH_CODEBUDDY_REASONING_EFFORT:'ultracode', DSH_CODEBUDDY_MAX_CONCURRENCY:'16', DSH_CODEBUDDY_QUEUE_TIMEOUT_MS:'2147483647', DSH_CODEBUDDY_STALL_WARN_MS:'0'}
  const configured = resolveConfig({}, env)
  assert.equal(configured.reasoningEffort, 'ultracode'); assert.equal(configured.maxConcurrency, 16)
  assert.equal(configured.queueTimeoutMs, 2147483647); assert.equal(configured.stallWarnMs, 0)
  assert.equal(resolveConfig({maxConcurrency:1}, env).maxConcurrency, 1)
  for (const effort of CODEBUDDY_EFFORTS) { assert.equal(isCodeBuddyEffort(effort), true); assert.equal(resolveConfig({reasoningEffort:effort}, {}).reasoningEffort, effort) }
  for (const effort of ['', 'AUTO', 'super', 1, true]) assert.throws(() => resolveConfig({reasoningEffort:effort}, {}), /reasoningEffort/)
  for (const [key, values] of Object.entries({maxConcurrency:[0,17,1.5,'',true,[],NaN], queueTimeoutMs:[0,2147483648,1.5,'',false,Infinity], stallWarnMs:[-1,2147483648,1.5,'',false]})) {
    for (const value of values) assert.throws(() => resolveConfig({[key]:value}, {}), new RegExp(key))
  }
})

test('runtime settings persist atomically and invalid updates leave live and saved settings unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-runtime-settings-'))
  try {
    const store = new SettingsStore({}, join(dir, 'settings.json'))
    const live = store.config
    const patch = {reasoningEffort:'xhigh', maxConcurrency:4, queueTimeoutMs:12000, stallWarnMs:0}
    store.update(patch)
    assert.equal(store.config, live)
    const saved = readFileSync(store.path, 'utf8')
    assert.deepEqual(JSON.parse(saved), patch)
    const restored = new SettingsStore({}, store.path)
    for (const [key, value] of Object.entries(patch)) assert.equal(restored.config[key as keyof typeof patch], value)
    assert.throws(() => store.update({maxConcurrency:17}), /maxConcurrency/)
    assert.throws(() => store.update({reasoningEffort:'invalid'}), /reasoningEffort/)
    assert.equal(store.config.maxConcurrency, 4)
    assert.equal(readFileSync(store.path, 'utf8'), saved)
  } finally { rmSync(dir, {recursive:true, force:true}) }
})

test('auth HTTP routes enforce same origin and never echo import secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(),'cb-auth-http-'))
  const routes = new Map<string, Parameters<WebServerLike['register']>[0]['handler']>()
  let configured = false; let imported: unknown; let cancelled = false
  const dispose = registerSettingsRoutes({register(route){routes.set(route.path,route.handler)}},new SettingsStore({},join(dir,'settings.json')),() => {},undefined,{
    status:async () => ({configured}), import:async value => {imported=value;configured=true}, clear:async () => {configured=false},
    start:async () => ({flowId:'flow',verificationUri:'https://www.codebuddy.cn/login'}),
    poll:async () => {throw new Error('private-token')},cancel:() => {},cancelAll:() => {cancelled=true},
  })
  const server = createServer((req,res) => routes.get(req.url!)!(req,res))
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/plugins/codebuddy-link/`
  const post = (action:string, body:unknown, origin?:string) => fetch(base+action,{method:'POST',headers:{'content-type':'application/json',...(origin ? {origin} : {})},body:JSON.stringify(body)})
  try {
    assert.equal((await fetch(base+'auth/start')).status,405)
    assert.equal((await post('auth/import',{content:'{}'},'https://evil.example')).status,403)
    assert.equal(imported,undefined)
    const saved = await post('auth/import',{content:JSON.stringify({access_token:'private-token',uid:'u'})})
    assert.deepEqual(await saved.json(),{configured:true})
    assert.deepEqual(imported,{access_token:'private-token',uid:'u'})
    const status = await (await fetch(base+'status')).json() as {runs:unknown[]}
    assert.deepEqual(status.runs, [])
    assert.ok(!JSON.stringify(status).includes('private-token'))
    const failed = await post('auth/poll',{flowId:'flow'})
    assert.equal(failed.status,400); assert.ok(!(await failed.text()).includes('private-token'))
    assert.deepEqual(await (await post('auth/clear',{})).json(),{configured:false})
  } finally {dispose();assert.equal(cancelled,true);server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));rmSync(dir,{recursive:true,force:true})}
})

test('settings persist, update live adapter catalog and reject invalid changes', async () => {
  const dir = mkdtempSync(join(tmpdir(),'cb-settings-'))
  try {
    const store = new SettingsStore({},join(dir,'settings.json'))
    const adapter = new CodeBuddyAdapter(store.config)
    store.update({models:['hy3','other'],hiddenModels:['other'],defaultModel:'hy3',permissionMode:'plan'})
    assert.deepEqual((await adapter.listModels()).map(m => m.id),['default','hy3'])
    assert.equal(new SettingsStore({},store.path).config.permissionMode,'plan')
    assert.throws(() => store.update({hiddenModels:['hy3']}),/enabled/)
    assert.throws(() => store.update({permissionMode:'bypassPermissions'}))
    assert.throws(() => store.update({codebuddyBin:'evil'}),/Unsupported/)
    assert.equal(store.config.permissionMode,'plan')
  } finally { rmSync(dir,{recursive:true,force:true}) }
})

test('concurrent refresh is single-flight and failures never disclose secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(),'cb-refresh-'))
  const routes = new Map<string, Parameters<WebServerLike['register']>[0]['handler']>()
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => {release = resolve})
  let started!: () => void
  const entered = new Promise<void>(resolve => {started = resolve})
  const dispose = registerSettingsRoutes({register(route){routes.set(route.path,route.handler)}},new SettingsStore({},join(dir,'settings.json')),() => {},async () => {
    calls++; started(); await gate; throw new Error('secret-token-must-not-leak')
  })
  const server = createServer((req,res) => routes.get(req.url!)!(req,res))
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/plugins/codebuddy-link/refresh`
  const post = () => fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
  try {
    const first = post(); await entered
    // Install the observer before issuing the second request.
    const secondEntered = new Promise<void>(resolve => { const handler = routes.get('/plugins/codebuddy-link/refresh')!; routes.set('/plugins/codebuddy-link/refresh',(req,res) => {handler(req,res);setImmediate(resolve)}) })
    const second = post()
    await secondEntered
    release()
    const bodies = await Promise.all([first,second].map(async response => (await response).text()))
    assert.equal(calls,1)
    assert.ok(bodies.every(body => !body.includes('secret-token-must-not-leak') && JSON.parse(body).account.status === 'error'))
  } finally {release();dispose();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));rmSync(dir,{recursive:true,force:true})}
})

test('run snapshots prioritize old nonterminal calls over newer history and cap sanitized metadata at 130', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-run-retention-'))
  const routes = new Map<string, Parameters<WebServerLike['register']>[0]['handler']>()
  const raw = {source:'model', requestedModel:'requested', requestedEffort:'high',
    contextOverrideSent:true, reasoningConfirmed:true, warning:true, queuePosition:0,
    prompt:'PRIVATE-PROMPT', rawOutput:'PRIVATE-OUTPUT', error:'PRIVATE-ERROR', path:'PRIVATE-PATH', token:'PRIVATE-TOKEN'}
  const terminal = Array.from({length:55}, (_, i) => ({...raw, id:`terminal-${i}`, state:['completed','failed','cancelled'][i % 3], queuedAt:1000 - i}))
  const live = Array.from({length:85}, (_, i) => ({...raw, id:`live-${i}`, state:['waiting','responding','starting','queued'][i % 4], queuedAt:100 - i}))
  let runs: unknown[] = [null, {id:'invalid'}, ...terminal, ...live.slice(0, 4)]
  const dispose = registerSettingsRoutes({register(route){routes.set(route.path, route.handler)}},
    new SettingsStore({}, join(dir, 'settings.json')), () => {}, undefined, undefined, undefined, () => runs)
  const server = createServer((req, res) => routes.get(req.url!)!(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/plugins/codebuddy-link/status`
  try {
    for (const count of [4, 85]) {
      runs = [null, {id:'invalid'}, ...terminal, ...live.slice(0, count)]
      const body = await (await fetch(url)).json() as {runs:Record<string, unknown>[]}
      assert.deepEqual(body.runs.map(run => run.id), [...live.slice(0, Math.min(count, 80)), ...terminal.slice(0, 50)].map(run => run.id))
      assert.equal(body.runs.length, Math.min(count, 80) + 50)
      assert.equal(body.runs[0]!.state, 'waiting'); assert.equal(body.runs[0]!.warning, true)
      assert.ok(body.runs.every(run => run.contextOverrideSent === false && run.reasoningConfirmed === false))
      assert.doesNotMatch(JSON.stringify(body), /PRIVATE-/)
    }
  } finally {dispose();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));rmSync(dir,{recursive:true,force:true})}
})

test('HTTP settings enforce method, same origin, JSON and publish refresh status', async () => {
  const dir = mkdtempSync(join(tmpdir(),'cb-http-'))
  const routes = new Map<string, Parameters<WebServerLike['register']>[0]['handler']>()
  const server = createServer((req,res) => { const handler = routes.get(req.url!); if(handler)handler(req,res);else{res.statusCode=404;res.end()} })
  let changed = 0
  const run = {id:'run-1', source:'model', state:'completed', requestedModel:'requested', requestedEffort:'auto', queuedAt:123,
    totalCredits:0, totalCostUsd:0, contextOverrideSent:false, reasoningConfirmed:false, warning:false, queuePosition:0,
    returnedModel:'https://host/private-secret', prompt:'private prompt', rawOutput:'private output', error:'private error', path:'private path'}
  const dispose = registerSettingsRoutes({register(route){routes.set(route.path,route.handler);return () => routes.delete(route.path)}},new SettingsStore({},join(dir,'settings.json')),() => {changed++},async () => ({status:'ok',remaining:23,unit:'积分'}), undefined, undefined, () => Array.from({length:55}, (_, i) => ({...run, id:`run-${i}`})))
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const address = server.address() as {port:number}; const base = `http://127.0.0.1:${address.port}/plugins/codebuddy-link`
  try {
    const initial = await (await fetch(base+'/status')).json() as {config:Record<string,unknown>; runs:Record<string,unknown>[]}
    assert.equal(initial.config.reasoningEffort,'auto'); assert.equal(initial.config.maxConcurrency,2)
    assert.equal(initial.config.queueTimeoutMs,600000); assert.equal(initial.config.stallWarnMs,90000)
    assert.equal(initial.runs.length,50); assert.equal(initial.runs[0]!.totalCredits,0); assert.equal(initial.runs[0]!.totalCostUsd,0)
    assert.equal(initial.runs[0]!.returnedModel,undefined)
    assert.doesNotMatch(JSON.stringify(initial), /private prompt|private output|private error|private path/)
    assert.equal((await fetch(base+'/config')).status,405)
    assert.equal((await fetch(base+'/config',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403)
    assert.equal((await fetch(base+'/config',{method:'POST',body:'{}'})).status,415)
    const saved = await fetch(base+'/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({models:['hy3'],permissionMode:'plan',reasoningEffort:'high',maxConcurrency:3,queueTimeoutMs:6000,stallWarnMs:0})})
    assert.equal(saved.status,200); assert.equal(changed,1)
    const settings = await saved.json() as {config:Record<string,unknown>}
    assert.equal(settings.config.reasoningEffort,'high'); assert.equal(settings.config.maxConcurrency,3)
    assert.equal(settings.config.queueTimeoutMs,6000); assert.equal(settings.config.stallWarnMs,0)
    assert.equal((await fetch(base+'/config',{method:'POST',headers:{'content-type':'application/json'},body:'{"queueTimeoutMs":2147483648}'})).status,400)
    assert.equal(changed,1)
    const refreshed = await fetch(base+'/refresh',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
    assert.equal((await refreshed.json() as {account:{remaining:number}}).account.remaining,23)
    assert.equal((await fetch(base+'/config',{method:'POST',headers:{'content-type':'application/json'},body:'invalid'})).status,400)
  } finally {dispose();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));rmSync(dir,{recursive:true,force:true})}
})
