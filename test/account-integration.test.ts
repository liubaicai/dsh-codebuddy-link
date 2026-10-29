import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { AccountStore } from '../src/accounts.ts'
import { AccountService } from '../src/account-service.ts'
import { resolveConfig } from '../src/config.ts'
import { CallRuntime } from '../src/runtime.ts'
import type { BridgeEvent, CodeBuddyRequest, runCodeBuddy } from '../src/runner.ts'
import { SettingsStore } from '../src/settings.ts'
import { registerSettingsRoutes, type WebServerLike } from '../src/web.ts'

const tokenA = 'PRIVATE-TOKEN-ALPHA'
const tokenB = 'PRIVATE-TOKEN-BETA'
const request: CodeBuddyRequest = {
  prompt: 'PRIVATE-PROMPT', cwd: 'PRIVATE-WORKSPACE', systemPrompt: 'PRIVATE-SYSTEM',
  model: 'hy3', effort: 'high', authToken: 'PRIVATE-CALLER-TOKEN',
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function collect(events: AsyncIterable<BridgeEvent>) {
  const result: BridgeEvent[] = []
  for await (const event of events) result.push(event)
  return result
}
async function eventually(check: () => boolean, message: string) {
  const deadline = Date.now() + 2000
  while (!check()) {
    assert.ok(Date.now() < deadline, message)
    await nextTurn()
  }
}
function fixture(t: TestContext, entry: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cb-account-integration-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const config = resolveConfig({ maxConcurrency: 4, queueTimeoutMs: 2000, ...entry }, {})
  const store = new AccountStore(join(dir, 'accounts.json'))
  const accounts = new AccountService(store, config)
  const runtime = new CallRuntime(config, accounts)
  return { dir, config, store, accounts, runtime }
}
async function seed(store: AccountStore) {
  const a = await store.upsert({ accessToken: tokenA, uid: 'PRIVATE-UID-ALPHA' })
  const b = await store.upsert({ accessToken: tokenB, uid: 'PRIVATE-UID-BETA' })
  return { a, b }
}
function assertPublic(value: unknown) {
  const serialized = JSON.stringify(value)
  assert.doesNotMatch(serialized, /PRIVATE-|accessToken|authToken|credential|systemPrompt|rawOutput/)
}

test('managed runtime injects the selected token per call, rereads rotation, and exposes metadata only', async t => {
  const { store, accounts, runtime } = fixture(t)
  const { a, b } = await seed(store)
  const seen: (string | undefined)[] = []
  const runner: typeof runCodeBuddy = async function* (req) {
    seen.push(req.authToken)
    req.onSpawn?.()
    assertPublic(runtime.snapshots())
    yield { type: 'metadata', model: 'hy3', totalCredits: 2 }
    yield { type: 'text', delta: 'PRIVATE-OUTPUT' }
    yield { type: 'result', text: 'PRIVATE-RESULT' }
  }
  await collect(runtime.run(request, 'model', runner))
  await accounts.configure({ mode: 'fixed', accountId: b.id })
  await collect(runtime.run(request, 'ask', runner))
  await store.upsert({ accessToken: 'PRIVATE-ROTATED-TOKEN', uid: 'PRIVATE-UID-BETA' }, b.id)
  await collect(runtime.run(request, 'model', runner))
  assert.deepEqual(seen, [tokenA, tokenB, 'PRIVATE-ROTATED-TOKEN'])
  assert.equal(request.authToken, 'PRIVATE-CALLER-TOKEN', 'injection must not mutate the caller request')
  assert.deepEqual(runtime.snapshots().map(row => row.accountId), [b.id, b.id, a.id])
  assert.deepEqual(runtime.snapshots().map(row => row.source), ['model', 'ask', 'model'])
  assert.ok(runtime.snapshots().every(row => row.state === 'completed'))
  assertPublic(runtime.snapshots())
  assertPublic(accounts.snapshot())
  assert.deepEqual(accounts.scheduler.activeCounts(), {})
})

test('pool balances independent sessions while retaining affinity across model and ask calls', async t => {
  const { store, accounts, runtime } = fixture(t)
  const { a, b } = await seed(store)
  await accounts.configure({ mode: 'pool' })
  const gate = deferred(), bothStarted = deferred()
  t.after(() => gate.resolve())
  const seen: { session: string | undefined; token: string | undefined }[] = []
  const runner: typeof runCodeBuddy = async function* (req) {
    seen.push({ session: req.sessionId, token: req.authToken })
    if (seen.length === 2) bothStarted.resolve()
    await gate.promise
    yield { type: 'result', text: 'ok' }
  }
  const first = collect(runtime.run({ ...request, sessionId: 'session-one' }, 'model', runner))
  const second = collect(runtime.run({ ...request, sessionId: 'session-two' }, 'ask', runner))
  await bothStarted.promise
  assert.deepEqual(new Set(seen.map(row => row.token)), new Set([tokenA, tokenB]))
  assert.deepEqual(accounts.scheduler.activeCounts(), { [a.id]: 1, [b.id]: 1 })
  const firstToken = seen.find(row => row.session === 'session-one')!.token
  gate.resolve()
  await Promise.all([first, second])
  await collect(runtime.run({ ...request, sessionId: 'session-one' }, 'ask', runner))
  await collect(runtime.run({ ...request, sessionId: 'session-one' }, 'model', runner))
  assert.ok(seen.filter(row => row.session === 'session-one').every(row => row.token === firstToken))
  assert.deepEqual(accounts.scheduler.activeCounts(), {})
})

test('one selected account serializes provider and ask even with spare global capacity', async t => {
  const { store, accounts, runtime } = fixture(t, { maxConcurrency: 4 })
  const { a } = await seed(store)
  const gate = deferred(), started = deferred()
  t.after(() => gate.resolve())
  let running = 0, maximum = 0, calls = 0
  const runner: typeof runCodeBuddy = async function* (req) {
    assert.equal(req.authToken, tokenA)
    running++; maximum = Math.max(maximum, running); calls++; started.resolve()
    try { await gate.promise; yield { type: 'result', text: 'ok' } }
    finally { running-- }
  }
  const provider = collect(runtime.run(request, 'model', runner))
  await started.promise
  const ask = collect(runtime.run(request, 'ask', runner))
  await nextTurn()
  assert.equal(calls, 1)
  assert.equal(accounts.scheduler.activeCounts()[a.id], 1)
  assert.equal(runtime.snapshots()[0]!.state, 'queued')
  gate.resolve()
  await Promise.all([provider, ask])
  assert.equal(calls, 2)
  assert.equal(maximum, 1)
  assert.deepEqual(accounts.scheduler.activeCounts(), {})
})

test('CLI-local fallback exists only for a store that has never managed an account', async t => {
  const { store, accounts, runtime } = fixture(t)
  let calls = 0
  const runner: typeof runCodeBuddy = async function* (req) {
    calls++; assert.equal(req.authToken, undefined)
    yield { type: 'result', text: 'ok' }
  }
  await collect(runtime.run({ ...request, authToken: undefined }, 'ask', runner))
  assert.equal(calls, 1)
  const a = await store.upsert({ accessToken: tokenA, uid: 'PRIVATE-UID-ALPHA' })
  await accounts.remove(a.id)
  await assert.rejects(collect(runtime.run({ ...request, authToken: undefined }, 'model', runner)))
  assert.equal(calls, 1)
  assert.equal(store.hasManagedAccounts(), true)
})

for (const change of ['disable', 'remove', 'delete-store'] as const) {
  test(`managed ${change} fails closed rather than invoking any fallback runner`, async t => {
    const { store, accounts, runtime } = fixture(t)
    const { a } = await seed(store)
    if (change === 'disable') await accounts.update(a.id, { enabled: false })
    else if (change === 'remove') await accounts.remove(a.id)
    else unlinkSync(store.path)
    let calls = 0
    const runner: typeof runCodeBuddy = async function* () { calls++; yield { type: 'result', text: 'unexpected' } }
    for (const source of ['model', 'ask'] as const) {
      await assert.rejects(collect(runtime.run(request, source, runner)))
    }
    assert.equal(calls, 0)
    assert.ok(runtime.snapshots().every(row => row.state === 'failed'))
    assertPublic(runtime.snapshots())
  })
}

test('disabling a selected account rejects its account-queued call without replay on another account', async t => {
  const { store, accounts, runtime } = fixture(t)
  const { a } = await seed(store)
  const gate = deferred(), started = deferred()
  t.after(() => gate.resolve())
  let calls = 0
  const runner: typeof runCodeBuddy = async function* () {
    calls++; started.resolve(); await gate.promise; yield { type: 'result', text: 'ok' }
  }
  const active = collect(runtime.run(request, 'model', runner))
  await started.promise
  const rejected = assert.rejects(collect(runtime.run(request, 'ask', runner)), { name: 'AccountSelectionError' })
  await nextTurn()
  await accounts.update(a.id, { enabled: false })
  await rejected
  assert.equal(calls, 1)
  gate.resolve(); await active
  assert.deepEqual(accounts.scheduler.activeCounts(), {})
})

for (const change of ['disable', 'remove', 'rotate'] as const) {
  test(`global-queued account is revalidated before spawn after ${change}`, async t => {
    const { store, accounts, runtime } = fixture(t, { maxConcurrency: 1 })
    const { a, b } = await seed(store)
    await accounts.configure({ mode: 'pool' })
    const gate = deferred(), started = deferred()
    t.after(() => gate.resolve())
    const seen: (string | undefined)[] = []
    const runner: typeof runCodeBuddy = async function* (req) {
      seen.push(req.authToken); started.resolve()
      if (req.sessionId === 'first') await gate.promise
      yield { type: 'result', text: 'ok' }
    }
    const active = collect(runtime.run({ ...request, sessionId: 'first' }, 'model', runner))
    await started.promise
    const queued = collect(runtime.run({ ...request, sessionId: 'second' }, 'ask', runner))
    // Attach rejection observation before changing the account.
    const outcome = queued.then(() => undefined, error => error as Error)
    await eventually(() => accounts.scheduler.activeCounts()[b.id] === 1 && runtime.snapshots()[0]?.queuePosition === 1,
      'second account should be reserved while waiting on global capacity')
    assert.equal(accounts.scheduler.activeCounts()[a.id], 1)
    if (change === 'disable') await accounts.update(b.id, { enabled: false })
    else if (change === 'remove') await accounts.remove(b.id)
    else await store.upsert({ accessToken: 'PRIVATE-ROTATED-TOKEN', uid: 'PRIVATE-UID-BETA' }, b.id)
    gate.resolve(); await active
    const failure = await outcome
    if (change === 'rotate') {
      assert.equal(failure, undefined)
      assert.deepEqual(seen, [tokenA, 'PRIVATE-ROTATED-TOKEN'])
    } else {
      assert.ok(failure instanceof Error)
      assert.deepEqual(seen, [tokenA])
    }
    assert.deepEqual(accounts.scheduler.activeCounts(), {})
  })
}

test('queued CLI-local request fails closed when account management starts before spawn', async t => {
  const { store, runtime } = fixture(t, { maxConcurrency: 1 })
  const gate = deferred(), started = deferred()
  t.after(() => gate.resolve())
  let calls = 0
  const runner: typeof runCodeBuddy = async function* () {
    calls++; started.resolve(); await gate.promise; yield { type: 'result', text: 'ok' }
  }
  const active = collect(runtime.run({ ...request, authToken: undefined }, 'model', runner))
  await started.promise
  const queued = collect(runtime.run({ ...request, authToken: undefined }, 'ask', runner))
  const rejected = assert.rejects(queued, /account management changed while queued/)
  await eventually(() => runtime.snapshots().some(row => row.queuePosition === 1), 'local call enters global queue')
  await seed(store)
  gate.resolve(); await Promise.all([active, rejected])
  assert.equal(calls, 1)
})

test('an old in-flight authentication failure cannot disable reauthorized credentials', async t => {
  const { store, accounts, runtime } = fixture(t)
  const { a } = await seed(store)
  const gate = deferred(), started = deferred()
  t.after(() => gate.resolve())
  const runner: typeof runCodeBuddy = async function* (req) {
    assert.equal(req.authToken, tokenA); started.resolve(); await gate.promise
    throw Object.assign(new Error('expired'), { name: 'CodeBuddyAuthError' })
    yield { type: 'result', text: '' }
  }
  const failed = assert.rejects(collect(runtime.run(request, 'model', runner)), { name: 'CodeBuddyAuthError' })
  await started.promise
  await store.upsert({ accessToken: 'PRIVATE-NEW-TOKEN', uid: 'PRIVATE-UID-ALPHA' }, a.id)
  gate.resolve(); await failed
  assert.equal(store.list().find(row => row.id === a.id)!.authState, 'ready')
  await accounts.invalidate(a.id, 'PRIVATE-NEW-TOKEN')
  assert.equal(store.list().find(row => row.id === a.id)!.authState, 'auth-required')
})

for (const name of ['Error', 'CodeBuddyAuthError']) {
  test(`${name} is not retried; only authentication failures mark the bound account auth-required`, async t => {
    const { store, accounts, runtime } = fixture(t)
    const { a, b } = await seed(store)
    await accounts.configure({ mode: 'pool' })
    let calls = 0
    const cause = Object.assign(new Error('PRIVATE-RUNNER-ERROR'), { name })
    const runner: typeof runCodeBuddy = async function* (req) {
      calls++; assert.equal(req.authToken, tokenA)
      throw cause
      yield { type: 'result', text: '' }
    }
    await assert.rejects(collect(runtime.run({ ...request, sessionId: 'failed-session' }, 'model', runner)), error => error === cause)
    assert.equal(calls, 1, 'a failure must not automatically replay with another account')
    assert.equal(store.list().find(row => row.id === a.id)!.authState, name === 'CodeBuddyAuthError' ? 'auth-required' : 'ready')
    assert.equal(store.list().find(row => row.id === b.id)!.authState, 'ready')
    assert.equal(runtime.snapshots()[0]!.state, 'failed')
    assertPublic(runtime.snapshots())
    assert.deepEqual(accounts.scheduler.activeCounts(), {})
    if (name === 'CodeBuddyAuthError') {
      await accounts.configure({ mode: 'fixed', accountId: a.id })
      await assert.rejects(collect(runtime.run(request, 'ask', runner)))
      assert.equal(calls, 1)
      await accounts.configure({ mode: 'pool' })
      await collect(runtime.run({ ...request, sessionId: 'failed-session' }, 'ask', async function* (req) {
        assert.equal(req.authToken, tokenB); yield { type: 'result', text: 'fresh call' }
      }))
    }
  })
}

for (const finish of ['abort', 'return'] as const) {
  test(`${finish} retains account AND global capacity until asynchronous runner cleanup finishes`, async t => {
    const { store, accounts, runtime } = fixture(t, { maxConcurrency: 1 })
    const { a, b } = await seed(store)
    await accounts.configure({ mode: 'pool' })
    const controller = new AbortController()
    const started = deferred(), cleanupStarted = deferred(), cleanupGate = deferred()
    t.after(() => { controller.abort(); cleanupGate.resolve() })
    const order: string[] = []
    const runner: typeof runCodeBuddy = async function* (req) {
      order.push(req.sessionId!)
      if (req.sessionId === 'same' && order.length === 1) {
        try {
          req.onSpawn?.(); started.resolve()
          if (finish === 'return') yield { type: 'text', delta: 'PRIVATE-PARTIAL' }
          else await new Promise<void>((_, reject) => {
            const abort = () => reject(Object.assign(new Error('PRIVATE-ABORT'), { name: 'AbortError' }))
            if (req.signal!.aborted) abort()
            else req.signal!.addEventListener('abort', abort, { once: true })
          })
        } finally { cleanupStarted.resolve(); await cleanupGate.promise; order.push('cleaned') }
      } else yield { type: 'result', text: 'ok' }
    }
    const first = runtime.run({ ...request, sessionId: 'same', signal: controller.signal }, 'model', runner)
    let completion: Promise<unknown>
    if (finish === 'abort') {
      completion = assert.rejects(collect(first), { name: 'AbortError' })
      await started.promise; controller.abort()
    } else {
      assert.equal((await first.next()).done, false)
      completion = first.return(undefined)
    }
    await cleanupStarted.promise
    const sameAccount = collect(runtime.run({ ...request, sessionId: 'same' }, 'ask', runner))
    const otherAccount = collect(runtime.run({ ...request, sessionId: 'other' }, 'ask', runner))
    await eventually(() => accounts.scheduler.activeCounts()[b.id] === 1, 'other account should reach the global queue')
    await nextTurn()
    assert.deepEqual(order, ['same'])
    assert.equal(accounts.scheduler.activeCounts()[a.id], 1, 'cleanup still owns the first account lease')
    assert.equal(runtime.snapshots().find(row => row.source === 'model')!.endedAt, undefined)
    assertPublic(runtime.snapshots())
    cleanupGate.resolve()
    await Promise.all([completion, sameAccount, otherAccount])
    assert.equal(order[1], 'cleaned', 'neither a same-account nor different-account runner starts before cleanup')
    assert.equal(order.length, 4)
    assert.equal(runtime.snapshots().find(row => row.source === 'model')!.state, 'cancelled')
    assert.deepEqual(accounts.scheduler.activeCounts(), {})
  })
}

test('expired account refresh cannot starve unrelated healthy account diagnostics', async t => {
  const { store, accounts } = fixture(t)
  const { a, b } = await seed(store)
  await accounts.configure({ mode: 'fixed', accountId: b.id })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (new Headers(init.headers).get('authorization') === `Bearer ${tokenA}`) return new Response('{}', { status: 401 })
    await eventually(() => store.list().find(row => row.id === a.id)?.authState === 'auth-required', 'expired account is invalidated first')
    return new Response(JSON.stringify({ code: 0, data: { resources: [{ total: 100, remaining: 25 }] } }))
  })
  for (let i = 0; i < 2; i++) {
    const value = await accounts.refresh()
    assert.equal(value.status, 'ok'); assert.equal(value.remaining, 25)
    assert.equal(accounts.snapshot().accounts.find(row => row.id === b.id)?.quota?.remaining, 25)
  }
})

test('real account HTTP service/store supports offline metadata CRUD/select/status and rejects malicious wire keys', async t => {
  const { dir, store, accounts, runtime } = fixture(t)
  // Account creation is the successful OAuth persistence boundary, not a token-import HTTP API.
  const { a, b } = await seed(store)
  const settings = new SettingsStore({}, join(dir, 'settings.json'))
  const routes = new Map<string, Parameters<WebServerLike['register']>[0]['handler']>()
  let notifications = 0, externalRequests = 0
  const localFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async () => { externalRequests++; throw new Error('Unexpected external network request') })
  const dispose = registerSettingsRoutes({ register(route) {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  } }, settings, () => { notifications++ }, () => accounts.refresh(), {
    status: async () => ({ configured: store.list().length > 0 }),
    start: async () => { throw new Error('OAuth is outside this offline metadata test') },
    poll: async () => { throw new Error('OAuth is outside this offline metadata test') },
    cancel: () => {}, cancelAll: () => {},
  }, undefined, () => runtime.snapshots(), accounts)
  const server = createServer((req, res) => {
    const handler = routes.get(req.url!)
    if (handler) handler(req, res)
    else { res.writeHead(404); res.end('Not found') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    dispose(); server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/plugins/codebuddy-link/`
  const send = async (action: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await localFetch(base + action, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await response.text()
    assertPublic(text)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return { status: response.status, body: JSON.parse(text) }
  }
  const initial = await send('status')
  assert.equal(initial.status, 200)
  assert.equal(initial.body.auth.configured, true)
  assert.equal(initial.body.accountPool.accounts.length, 2)
  assert.equal(initial.body.accountPool.selectedAccountId, a.id)
  const updated = await send('account/update', { id: a.id, name: 'Primary account' })
  assert.equal(updated.status, 200)
  assert.equal(store.list().find(row => row.id === a.id)!.name, 'Primary account')
  assert.equal((await send('account/select', { mode: 'fixed', accountId: b.id })).status, 200)
  assert.equal(store.snapshot().selectedAccountId, b.id)
  assert.equal((await send('account/select', { mode: 'pool' })).status, 200)
  assert.equal(store.snapshot().mode, 'pool')
  assert.equal(store.snapshot().selectedAccountId, undefined)
  assert.equal((await send('account/update', { id: a.id, enabled: false })).status, 200)
  assert.equal(store.list().find(row => row.id === a.id)!.enabled, false)
  const before = store.snapshot(), revision = store.revision, beforeNotifications = notifications
  const malicious: [string, unknown][] = [
    ['account/update', { id: b.id, accessToken: 'PRIVATE-INJECTED-TOKEN' }],
    ['account/update', { id: b.id, credential: { uid: 'PRIVATE-INJECTED-UID' } }],
    ['account/update', { id: b.id, authState: 'ready' }],
    ['account/update', `{"id":"${b.id}","__proto__":{"polluted":true}}`],
    ['account/update', { id: b.id, constructor: { prototype: { polluted: true } } }],
    ['account/update', { id: b.id, enabled: 'true' }],
    ['account/update', { id: b.id, name: 'bad\nname' }],
    ['account/remove', { id: b.id, path: 'PRIVATE-ARBITRARY-PATH' }],
    ['account/select', { mode: 'pool', accountId: b.id }],
    ['account/select', { mode: 'fixed', accountId: a.id }],
    ['account/select', { mode: 'fixed', accountId: '../PRIVATE-PATH' }],
    ['account/select', { mode: 'pool', token: 'PRIVATE-INJECTED-TOKEN' }],
    ['account/refresh', { id: b.id, url: 'https://evil.invalid/PRIVATE-TOKEN' }],
    ['auth/start', { accessToken: 'PRIVATE-INJECTED-TOKEN' }],
    ['account/remove', []],
  ]
  for (const [action, body] of malicious) {
    assert.equal((await send(action, body)).status, 400, `${action} must reject ${JSON.stringify(body)}`)
    assert.deepEqual(store.snapshot(), before)
    assert.equal(store.revision, revision)
  }
  assert.equal(notifications, beforeNotifications)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
  assert.equal((await send('account/update')).status, 405)
  assert.equal((await send('account/remove', { id: b.id }, { origin: 'https://evil.invalid' })).status, 403)
  assert.equal((await send('account/remove', { id: b.id }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  for (const path of ['auth/import', 'account/import', 'accounts/import']) {
    assert.equal(routes.has('/plugins/codebuddy-link/' + path), false)
    const response = await localFetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: 'PRIVATE-INJECTED-TOKEN' }) })
    assert.equal(response.status, 404)
    assertPublic(await response.text())
  }
  assert.equal((await send('account/remove', { id: a.id })).status, 200)
  assert.equal((await send('account/remove', { id: b.id })).status, 200)
  const empty = await send('status')
  assert.deepEqual(empty.body.accountPool.accounts, [])
  assert.equal(empty.body.auth.configured, false)
  assert.equal(store.hasManagedAccounts(), true)
  assert.equal(externalRequests, 0, 'metadata routes must never call OAuth, quota, or discovery endpoints')
})
