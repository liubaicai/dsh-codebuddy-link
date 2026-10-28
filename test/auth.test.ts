import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthManager, AuthStore, parseCredential } from '../src/auth.ts'

const secret = 'synthetic-token-DO-NOT-LEAK'
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cb-auth-'))
  return { dir, store: new AuthStore(join(dir, 'private', 'credentials.json')), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
function json(data: unknown): Response { return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }) }
function response(data: unknown): Response { return json({ code: 0, data }) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const stateResponse = () => response({ state: 'private-state', authUrl: 'https://www.codebuddy.cn/login?state=private-state' })

test('strict imports normalize both shapes, discard extra fields, and never accept bare/protected tokens', () => {
  for (const input of [
    { access_token: secret, uid: 'u_1', refresh_token: 'discard', nickname: 'discard' },
    { accessToken: secret, uid: 'u_1', domain: 'www.codebuddy.cn' },
    { auth: { accessToken: secret, tokenType: 'Bearer', refreshToken: 'discard' }, account: { uid: 'u_1' } },
  ]) assert.deepEqual(parseCredential(JSON.stringify(input)), { accessToken: secret, uid: 'u_1' })
  for (const input of [secret, 'null', '[]', '123', {}, { accessToken: secret },
    { accessToken: secret, uid: 123 }, { accessToken: secret, uid: 'x\r\ny' },
    { accessToken: 'x\r\ny', uid: 'u' }, { accessToken: 'encrypted:abc', uid: 'u' },
    { accessToken: secret, access_token: 'different', uid: 'u' },
    { auth: { accessToken: secret }, account: { uid: 'u' }, uid: 'other' },
    { auth: { accessToken: secret, tokenType: 'Basic' }, account: { uid: 'u' } },
    { accessToken: secret, uid: 'u', enterprise_id: 'enterprise' },
    { auth: { accessToken: secret, domain: 'evil.example' }, account: { uid: 'u' } },
    { auth: { accessToken: secret }, account: { uid: 'u', enterpriseId: 'corp' } },
    { accessToken: secret, uid: 'u', domain: 'https://www.codebuddy.cn.evil.example' },
    { accessToken: secret, uid: 'u', baseUrl: 'http://127.0.0.1' },
  ]) assert.throws(() => parseCredential(input), error => error instanceof Error && !error.message.includes(secret))
})

test('store is private, atomic, minimal, clearable; invalid imports preserve existing credentials', async () => {
  const f = fixture()
  try {
    assert.deepEqual(await f.store.status(), { configured: false })
    assert.equal(await f.store.read(), undefined)
    await f.store.import({ access_token: secret, uid: 'user', refreshToken: 'discard', email: 'discard' })
    assert.deepEqual(await f.store.read(), { accessToken: secret, uid: 'user' })
    assert.deepEqual(await f.store.status(), { configured: true })
    assert.deepEqual(JSON.parse(readFileSync(f.store.path, 'utf8')), { accessToken: secret, uid: 'user' })
    assert.deepEqual(readdirSync(join(f.dir, 'private')), ['credentials.json'])
    if (process.platform !== 'win32') {
      assert.equal(statSync(f.store.path).mode & 0o777, 0o600)
      assert.equal(statSync(join(f.dir, 'private')).mode & 0o777, 0o700)
    }
    await assert.rejects(f.store.import(secret))
    assert.equal((await f.store.read())?.uid, 'user')
    await f.store.clear(); await f.store.clear()
    assert.deepEqual(await f.store.status(), { configured: false })
  } finally { f.cleanup() }
})

test('invalid or overlarge stored JSON gives safe errors and unconfigured status', async () => {
  const f = fixture()
  try {
    await f.store.import({ accessToken: secret, uid: 'user' })
    for (const data of [secret, ' '.repeat(65537)]) {
      writeFileSync(f.store.path, data)
      await assert.rejects(f.store.read(), error => error instanceof Error && !error.message.includes(secret))
      assert.deepEqual(await f.store.status(), { configured: false })
    }
  } finally { f.cleanup() }
})

test('OAuth uses fixed endpoints, hidden state, account uid and minimal credentials; no refresh', async () => {
  const f = fixture(), calls: Array<{ url: string; init?: RequestInit }> = []
  const queue = [stateResponse(), response({ access_token: secret, refresh_token: 'discard' }), response({ accounts: [{ uid: 'first' }, { uid: 'last', lastLogin: true }] })]
  const manager = new AuthManager(f.store, { now: () => 1000, fetch: async (url, init) => { calls.push({ url: String(url), init }); return queue.shift()! } })
  try {
    const started = await manager.start()
    assert.equal(started.expiresIn, 600); assert.equal(started.interval, 2)
    assert.match(started.flowId, /^[a-f0-9]{64}$/)
    assert.equal('state' in started, false)
    assert.notEqual(started.flowId, 'private-state')
    assert.deepEqual(await manager.poll(started.flowId), { status: 'ok' })
    assert.deepEqual(await manager.poll(started.flowId), { status: 'ok' })
    assert.deepEqual(await f.store.read(), { accessToken: secret, uid: 'last' })
    assert.deepEqual(calls.map(call => call.url), [
      'https://www.codebuddy.cn/v2/plugin/auth/state?platform=workbuddy',
      'https://www.codebuddy.cn/v2/plugin/auth/token?state=private-state',
      'https://www.codebuddy.cn/v2/plugin/accounts',
    ])
    assert.equal(calls[0]?.init?.method, 'POST'); assert.equal(calls[0]?.init?.body, '{}')
    assert.ok(calls.every(call => call.init?.redirect === 'error' && call.init?.signal instanceof AbortSignal))
    assert.equal(new Headers(calls[2]?.init?.headers).get('Authorization'), 'Bearer ' + secret)
  } finally { f.cleanup() }
})

test('OAuth start reports remaining lifetime after upstream latency, not a fixed 600 seconds', async () => {
  for (const [latency, expiresIn] of [[1, 600], [1000, 599], [1763, 599], [599999, 1]] as const) {
    const f = fixture(), startedAt = 1000
    let now = startedAt
    const manager = new AuthManager(f.store, { now: () => now, fetch: async () => {
      now = startedAt + latency
      // Shape of the public start endpoint; never include live state or credentials in fixtures.
      return json({ code: 0, msg: 'success', requestId: 'synthetic-request', data: {
        state: 'synthetic-state', authUrl: 'https://www.codebuddy.cn/login?state=synthetic-state',
      } })
    } })
    try {
      const flow = await manager.start()
      assert.equal(flow.expiresIn, expiresIn)
      assert.equal(flow.interval, 2)
      assert.equal(flow.verificationUri, 'https://www.codebuddy.cn/login?state=synthetic-state')
      assert.equal('state' in flow, false)
      // Rounding the displayed lifetime must not extend the actual server-side deadline.
      now = startedAt + 600000
      await assert.rejects(manager.poll(flow.flowId), /no longer active/)
      assert.equal(await f.store.read(), undefined)
    } finally { manager.cancelAll(); f.cleanup() }
  }
})

test('OAuth start cannot publish a flow once its lifetime was consumed by the request', async () => {
  for (const latency of [600000, 600001]) {
    const f = fixture()
    let now = 0
    const manager = new AuthManager(f.store, { now: () => now, fetch: async () => {
      now = latency
      return stateResponse()
    } })
    try {
      await assert.rejects(manager.start(), /no longer active/)
      assert.equal(await f.store.read(), undefined)
    } finally { manager.cancelAll(); f.cleanup() }
  }
})

test('poll throttles at two seconds and shares in-flight requests', async () => {
  const f = fixture(), gate = deferred<Response>()
  let now = 0, count = 0
  const manager = new AuthManager(f.store, { now: () => now, fetch: async () => { count++; return count === 1 ? stateResponse() : count === 2 ? gate.promise : json({ code: 1 }) } })
  try {
    const flow = await manager.start()
    const first = manager.poll(flow.flowId), second = manager.poll(flow.flowId)
    assert.equal(count, 2)
    gate.resolve(json({ code: 1, message: secret }))
    assert.deepEqual(await first, { status: 'pending', interval: 2 }); assert.deepEqual(await second, await first)
    now = 1999; await manager.poll(flow.flowId); assert.equal(count, 2)
    now = 2000; await manager.poll(flow.flowId); assert.equal(count, 3)
    now = 600000; await assert.rejects(manager.poll(flow.flowId)); assert.equal(count, 3)
  } finally { f.cleanup() }
})

test('cancel, replacement, direct clear and direct import block late account results', async () => {
  for (const action of ['cancel', 'replace', 'clear', 'import', 'expire'] as const) {
    const f = fixture(), account = deferred<Response>(), entered = deferred<void>()
    let now = 0
    const manager = new AuthManager(f.store, { now: () => now, fetch: async url => {
      if (String(url).includes('/auth/state')) return stateResponse()
      if (String(url).includes('/auth/token')) return response({ accessToken: secret })
      entered.resolve(); return account.promise
    } })
    try {
      const flow = await manager.start(), poll = manager.poll(flow.flowId)
      const rejected = assert.rejects(poll)
      await entered.promise
      if (action === 'cancel') manager.cancel(flow.flowId)
      if (action === 'replace') await manager.start()
      if (action === 'clear') await f.store.clear()
      if (action === 'import') await f.store.import({ accessToken: 'replacement', uid: 'new-user' })
      if (action === 'expire') now = 600000
      account.resolve(response({ accounts: [{ uid: 'old-user' }] }))
      await rejected
      assert.deepEqual(await f.store.read(), action === 'import' ? { accessToken: 'replacement', uid: 'new-user' } : undefined)
    } finally { f.cleanup() }
  }
})

test('replaced starts and cleared starts cannot publish a late flow', async () => {
  for (const clear of [false, true]) {
    const f = fixture(), gate = deferred<Response>()
    let count = 0
    const manager = new AuthManager(f.store, { fetch: async () => ++count === 1 ? gate.promise : stateResponse() })
    try {
      const first = manager.start(), rejected = assert.rejects(first)
      if (clear) await f.store.clear(); else await manager.start()
      gate.resolve(stateResponse()); await rejected
    } finally { manager.cancelAll(); f.cleanup() }
  }
})

test('auth URLs cannot change origin, contain credentials, or downgrade HTTPS', async () => {
  for (const authUrl of ['http://www.codebuddy.cn/login', 'https://evil.example', 'https://www.codebuddy.cn.evil.example', 'https://user:pass@www.codebuddy.cn/login', 'https://www.codebuddy.cn:444/login', '//www.codebuddy.cn/login', 'javascript:alert(1)']) {
    const f = fixture(), manager = new AuthManager(f.store, { fetch: async () => response({ state: 'state', authUrl }) })
    try { await assert.rejects(manager.start()); assert.equal(await f.store.read(), undefined) }
    finally { f.cleanup() }
  }
})

test('HTTP failures, redirect results, malformed/oversize bodies and fetch errors are sanitized', async () => {
  const cases: Array<() => Promise<Response>> = [
    async () => new Response(secret, { status: 401 }),
    async () => new Response(secret),
    async () => new Response(' '.repeat(65537)),
    async () => { throw new Error(secret) },
    async () => { const res = stateResponse(); Object.defineProperty(res, 'redirected', { value: true }); return res },
    async () => { const res = stateResponse(); Object.defineProperty(res, 'url', { value: 'https://evil.example' }); return res },
    async () => response({ state: secret, authUrl: 'https://evil.example/' + secret }),
  ]
  for (const fetcher of cases) {
    const f = fixture(), manager = new AuthManager(f.store, { fetch: fetcher })
    try { await assert.rejects(manager.start(), error => error instanceof Error && !error.message.includes(secret)) }
    finally { f.cleanup() }
  }
})

test('enterprise accounts, unknown domains and missing uid never persist', async () => {
  for (const [auth, account] of [
    [{ accessToken: secret, domain: 'evil.example' }, { uid: 'u' }],
    [{ accessToken: secret }, { uid: 'u', enterpriseId: 'corp' }],
    [{ accessToken: secret }, { email: 'not-a-uid' }],
  ]) {
    const f = fixture(), queue = [stateResponse(), response(auth), response({ accounts: [account] })]
    const manager = new AuthManager(f.store, { fetch: async () => queue.shift()! })
    try { const flow = await manager.start(); await assert.rejects(manager.poll(flow.flowId)); assert.equal(await f.store.read(), undefined) }
    finally { f.cleanup() }
  }
})

test('fallback verification URL encodes state; wrong flow IDs cannot cancel an active flow', async () => {
  const f = fixture(), calls: string[] = []
  const manager = new AuthManager(f.store, { fetch: async url => {
    calls.push(String(url))
    return calls.length === 1 ? response({ state: 'a&b?c' }) : json({ code: 1 })
  } })
  try {
    const flow = await manager.start()
    assert.equal(flow.verificationUri, 'https://www.codebuddy.cn/login?state=a%26b%3Fc')
    manager.cancel('wrong-id')
    await assert.rejects(manager.poll('wrong-id'))
    assert.deepEqual(await manager.poll(flow.flowId), { status: 'pending', interval: 2 })
    assert.equal(calls[1], 'https://www.codebuddy.cn/v2/plugin/auth/token?state=a%26b%3Fc')
    manager.cancel(flow.flowId)
    await assert.rejects(manager.poll(flow.flowId))
  } finally { f.cleanup() }
})

test('request timeout is bounded even if fetch ignores abort', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(), manager = new AuthManager(f.store, { fetch: () => new Promise<Response>(() => {}) })
  try {
    const start = manager.start(), rejected = assert.rejects(start, /failed or timed out/)
    context.mock.timers.tick(15000)
    await rejected
  } finally { manager.cancelAll(); f.cleanup() }
})
