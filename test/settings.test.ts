import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('panel updates preserve legacy administrator settings while internal metadata updates remain available', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-panel-boundary-'))
  const path = join(dir, 'settings.json')
  try {
    const legacy = {tools:'Read', maxConcurrency:7, queueTimeoutMs:12345, stallWarnMs:800, modelContext:{hy3:262144}}
    writeFileSync(path, JSON.stringify(legacy))
    const store = new SettingsStore({}, path)
    const before = readFileSync(path, 'utf8')
    for (const [key, value] of Object.entries(legacy)) {
      assert.throws(() => store.updateFromPanel({permissionMode:'plan', [key]:value}), /administrator-only/)
      assert.equal(store.config.permissionMode, 'dontAsk')
      assert.equal(readFileSync(path, 'utf8'), before)
    }
    store.updateFromPanel({permissionMode:'plan', executionMode:'bridge'})
    for (const [key, value] of Object.entries(legacy)) assert.deepEqual((store.config as unknown as Record<string, unknown>)[key], value)
    store.update({modelContext:{...store.config.modelContext, discovered:100000}})
    assert.equal(new SettingsStore({}, path).config.modelContext.discovered, 100000)
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(path, 'utf8')), 'executionMode'), false)
  } finally { rmSync(dir, {recursive:true, force:true}) }
})

test('model discovery still persists trusted context metadata after panel updates are restricted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-discovery-settings-'))
  const routes = new Map<string, Parameters<WebServerLike['register']>[0]['handler']>()
  const store = new SettingsStore({modelContext:{existing:128000}}, join(dir,'settings.json'))
  const message = '已获取中国区官方 CLI 目录。 模型候选未验证账户可用权限；实际调用仍受地区、账户权限与余额限制。'
  const dispose = registerSettingsRoutes({register(route){routes.set(route.path,route.handler)}}, store, () => {}, undefined, undefined,
    async () => ({models:[{id:'discovered',name:'Discovered',contextWindow:262144}],message}))
  const server = createServer((req,res) => routes.get(req.url!)!(req,res))
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/plugins/codebuddy-link/`
  try {
    const response = await fetch(base+'models',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
    assert.equal(response.status,200)
    assert.equal((await response.json() as {modelMessage:string}).modelMessage,message)
    assert.deepEqual(new SettingsStore({}, store.path).config.modelContext,{existing:128000,discovered:262144})
    assert.equal((await (await fetch(base+'status')).json() as {modelMessage:string}).modelMessage,message)
  } finally {dispose();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));rmSync(dir,{recursive:true,force:true})}
})

test('status relays only the fixed account-store repair diagnostic, never arbitrary snapshot failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-status-diagnostic-'))
  const routes = new Map<string, Parameters<WebServerLike['register']>[0]['handler']>()
  let message = 'Cannot read CodeBuddy accounts; repair the account store before continuing'
  const dispose = registerSettingsRoutes({register(route){routes.set(route.path,route.handler)}}, new SettingsStore({},join(dir,'settings.json')), () => {}, undefined, {
    status:async () => {throw new Error(message)}, start:async () => ({}), poll:async () => ({}), cancel:() => {}, cancelAll:() => {},
  })
  const server = createServer((req,res) => routes.get(req.url!)!(req,res))
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/plugins/codebuddy-link/status`
  try {
    const response = await fetch(url)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {error:message})
    message = 'PRIVATE-TOKEN C:\\PRIVATE-PATH'
    const unknown = await fetch(url)
    assert.equal(unknown.status, 400)
    assert.doesNotMatch(await unknown.text(), /PRIVATE-/)
  } finally {dispose();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));rmSync(dir,{recursive:true,force:true})}
})

test('runtime settings persist atomically and invalid updates leave live and saved settings unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-runtime-settings-'))
  try {
    const store = new SettingsStore({}, join(dir, 'settings.json'))
    const live = store.config
    assert.equal(store.config.executionMode, 'autonomous'); assert.equal(store.config.dangerouslySkipPermissions, false)
    const patch = {reasoningEffort:'xhigh', maxConcurrency:4, queueTimeoutMs:12000, stallWarnMs:0, dangerouslySkipPermissions:true}
    store.update(patch)
    assert.equal(store.config, live)
    const saved = readFileSync(store.path, 'utf8')
    assert.deepEqual(JSON.parse(saved), patch)
    const restored = new SettingsStore({}, store.path)
    for (const [key, value] of Object.entries(patch)) assert.equal(restored.config[key as keyof typeof patch], value)
    assert.throws(() => store.update({maxConcurrency:17}), /maxConcurrency/)
    assert.throws(() => store.update({reasoningEffort:'invalid'}), /reasoningEffort/)
    assert.throws(() => store.update({dangerouslySkipPermissions:1}), /dangerouslySkipPermissions/)
    assert.equal(store.config.executionMode, 'autonomous'); assert.equal(store.config.dangerouslySkipPermissions, true)
    assert.equal(store.config.maxConcurrency, 4)
    assert.equal(readFileSync(store.path, 'utf8'), saved)
    // Settings written by older plugin versions keep loading and are migrated:
    // the retired executionMode key is dropped on load and never re-persisted.
    writeFileSync(store.path, JSON.stringify({...JSON.parse(saved), executionMode:'bridge'}))
    const migrated = new SettingsStore({}, store.path)
    assert.equal(migrated.config.executionMode, 'autonomous')
    migrated.update({maxConcurrency:5})
    assert.ok(!Object.hasOwn(JSON.parse(readFileSync(store.path, 'utf8')), 'executionMode'))
    // A stale pre-upgrade settings page may still send the retired key; the
    // patch is tolerated (key ignored), not rejected, and never persisted.
    migrated.update({executionMode:'autonomous', maxConcurrency:6})
    assert.equal(migrated.config.executionMode, 'autonomous'); assert.equal(migrated.config.maxConcurrency, 6)
    assert.ok(!Object.hasOwn(JSON.parse(readFileSync(store.path, 'utf8')), 'executionMode'))
    assert.throws(() => migrated.update({unknownSetting:1}), /Unsupported setting/)
  } finally { rmSync(dir, {recursive:true, force:true}) }
})

test('invalid saved settings preserve the original and disable execution without losing recovery status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-settings-recovery-'))
  const path = join(dir, 'settings.json')
  try {
    for (const original of ['{broken PRIVATE', '[]', '{"unknown-PRIVATE":true}', '{"codebuddyBin":"PRIVATE"}', '{"permissionMode":"unsafe"}', '{"models":["bad/path"]}']) {
      writeFileSync(path, original)
      const store = new SettingsStore({enabled:true, askTool:true, tools:'all', dangerouslySkipPermissions:true}, path)
      assert.match(store.loadError!, /disabled.*Repair.*restart/)
      assert.doesNotMatch(store.loadError!, /PRIVATE|unsafe/)
      assert.equal(store.config.enabled, false); assert.equal(store.config.askTool, false)
      assert.equal(store.config.tools, ''); assert.equal(store.config.dangerouslySkipPermissions, false)
      assert.throws(() => store.update({permissionMode:'plan'}), /Repair/)
      assert.equal(readFileSync(path, 'utf8'), original)
    }
    const routes = new Map<string, Parameters<WebServerLike['register']>[0]['handler']>()
    const store = new SettingsStore({}, path)
    let changed = false
    const dispose = registerSettingsRoutes({register(route){routes.set(route.path,route.handler)}}, store, () => {changed=true})
    const server = createServer((req,res) => routes.get(req.url!)!(req,res))
    await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
    const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/plugins/codebuddy-link/`
    try {
      const response = await fetch(base+'status')
      assert.equal(response.status, 200)
      const status = await response.json() as {settingsError:string;config:{enabled:boolean}}
      assert.match(status.settingsError, /Repair/); assert.equal(status.config.enabled,false)
      assert.equal((await fetch(base+'config',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,400)
      assert.equal(changed,false)
    } finally { dispose();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve())) }
    writeFileSync(path, '{"permissionMode":"plan"}')
    assert.equal(new SettingsStore({},path).loadError, undefined)
    assert.equal(new SettingsStore({},path).config.enabled, true)
    assert.equal(new SettingsStore({},path).config.permissionMode, 'plan')
  } finally { rmSync(dir,{recursive:true,force:true}) }
})

test('auth HTTP routes enforce same origin, remove JSON import, and never echo secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(),'cb-auth-http-'))
  const routes = new Map<string, Parameters<WebServerLike['register']>[0]['handler']>()
  let configured = false; let cancelled = false
  const dispose = registerSettingsRoutes({register(route){routes.set(route.path,route.handler)}},new SettingsStore({},join(dir,'settings.json')),() => {},undefined,{
    status:async () => ({configured}),
    start:async () => ({flowId:'flow',verificationUri:'https://www.codebuddy.cn/login'}),
    poll:async () => {throw new Error('private-token')},cancel:() => {},cancelAll:() => {cancelled=true},
  })
  const server = createServer((req,res) => routes.get(req.url!)!(req,res))
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/plugins/codebuddy-link/`
  const post = (action:string, body:unknown, origin?:string) => fetch(base+action,{method:'POST',headers:{'content-type':'application/json',...(origin ? {origin} : {})},body:JSON.stringify(body)})
  try {
    assert.equal((await fetch(base+'auth/start')).status,405)
    assert.equal((await post('auth/start',{},'https://evil.example')).status,403)
    assert.equal(routes.has('/plugins/codebuddy-link/auth/import'),false)
    assert.equal(routes.has('/plugins/codebuddy-link/auth/clear'),false)
    const saved = await post('auth/start',{})
    assert.equal(saved.status,200)
    const status = await (await fetch(base+'status')).json() as {runs:unknown[]}
    assert.deepEqual(status.runs, [])
    assert.ok(!JSON.stringify(status).includes('private-token'))
    const failed = await post('auth/poll',{flowId:'flow'})
    assert.equal(failed.status,400); assert.ok(!(await failed.text()).includes('private-token'))
    assert.deepEqual(await (await post('auth/cancel',{flowId:'flow'})).json(),{status:'cancelled'})
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

test('run snapshots expose only the latest five calls, independent of state or input order', async () => {
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
      const newest = {...live[0], id:'newest-live', queuedAt:2000}
      runs = [null, {id:'invalid'}, ...live.slice(0, count), ...terminal.toReversed(), newest]
      const body = await (await fetch(url)).json() as {runs:Record<string, unknown>[]}
      assert.deepEqual(body.runs.map(run => run.id), [newest, ...terminal.slice(0, 4)].map(run => run.id))
      assert.equal(body.runs.length, 5)
      assert.equal(body.runs[0]!.state, 'waiting'); assert.equal(body.runs[0]!.warning, true)
      assert.ok(body.runs.every(run => run.contextOverrideSent === false && run.reasoningConfirmed === false))
      assert.doesNotMatch(JSON.stringify(body), /PRIVATE-/)
    }
    runs = Array.from({length:8}, (_, i) => ({...raw, id:`tie-${i}`, state:'completed', queuedAt:100}))
    const tied = await (await fetch(url)).json() as {runs:Record<string, unknown>[]}
    assert.deepEqual(tied.runs.map(run => run.id), ['tie-0','tie-1','tie-2','tie-3','tie-4'])
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
    assert.equal(initial.config.executionMode,undefined); assert.equal(initial.config.dangerouslySkipPermissions,false)
    assert.equal(initial.config.reasoningEffort,'auto'); assert.equal(initial.config.maxConcurrency,2)
    assert.equal(initial.config.queueTimeoutMs,600000); assert.equal(initial.config.stallWarnMs,90000)
    assert.equal(initial.runs.length,5); assert.equal(initial.runs[0]!.totalCredits,0); assert.equal(initial.runs[0]!.totalCostUsd,0)
    assert.equal(initial.runs[0]!.returnedModel,undefined)
    assert.doesNotMatch(JSON.stringify(initial), /private prompt|private output|private error|private path/)
    assert.equal((await fetch(base+'/config')).status,405)
    assert.equal((await fetch(base+'/config',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403)
    assert.equal((await fetch(base+'/config',{method:'POST',body:'{}'})).status,415)
    const saved = await fetch(base+'/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({models:['hy3'],permissionMode:'plan',reasoningEffort:'high',executionMode:'bridge',dangerouslySkipPermissions:true})})
    assert.equal(saved.status,200); assert.equal(changed,1)
    const settings = await saved.json() as {config:Record<string,unknown>}
    assert.equal(settings.config.executionMode,undefined); assert.equal(settings.config.dangerouslySkipPermissions,true)
    assert.equal(settings.config.reasoningEffort,'high'); assert.equal(settings.config.maxConcurrency,2)
    assert.equal(settings.config.queueTimeoutMs,600000); assert.equal(settings.config.stallWarnMs,90000)
    for (const patch of [{tools:'default'}, {maxConcurrency:3}, {queueTimeoutMs:6000}, {stallWarnMs:0}, {modelContext:{hy3:1}}]) {
      const rejected = await fetch(base+'/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({permissionMode:'acceptEdits', ...patch})})
      assert.equal(rejected.status,400)
    }
    const unchanged = await (await fetch(base+'/status')).json() as {config:Record<string,unknown>}
    assert.equal(unchanged.config.permissionMode,'plan')
    assert.equal((await fetch(base+'/config',{method:'POST',headers:{'content-type':'application/json'},body:'{"queueTimeoutMs":2147483648}'})).status,400)
    assert.equal(changed,1)
    const refreshed = await fetch(base+'/refresh',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
    assert.equal((await refreshed.json() as {account:{remaining:number}}).account.remaining,23)
    assert.equal((await fetch(base+'/config',{method:'POST',headers:{'content-type':'application/json'},body:'invalid'})).status,400)
  } finally {dispose();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));rmSync(dir,{recursive:true,force:true})}
})
