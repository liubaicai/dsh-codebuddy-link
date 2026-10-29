import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountScheduler, type AccountSnapshot, type AccountSchedulerOptions, type AccountLease } from '../src/account-scheduler.ts'

const secret = 'synthetic-token-DO-NOT-LEAK'
const account = (id: string) => ({ id, name: `Account ${id}`, enabled: true, authState: 'ready' as const })
const credential = { accessToken: secret, uid: 'user' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture(options: Partial<AccountSchedulerOptions> = {}) {
  let state: AccountSnapshot = { mode: 'pool', accounts: ['a', 'b', 'c'].map(account) }
  const reads: string[] = []
  const scheduler = new AccountScheduler({
    snapshot: async () => state,
    readCredential: async id => { reads.push(id); return credential },
    queueTimeoutMs: () => 5000,
    ...options,
  })
  return { scheduler, reads, state: () => state, set: (value: AccountSnapshot) => { state = value; scheduler.refresh() } }
}
const safeError = (name: string, pattern?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof Error)
  assert.equal(error.name, name)
  assert.ok(!String(error.stack).includes(secret))
  assert.equal(error.cause, undefined)
  if (pattern) assert.match(error.message, pattern)
  return true
}

// Queue timeouts are deliberately long unless the test is about timeout itself.
// Every acquired lease is released; no child executions or transport replay exist here.
test('many sessions balance round robin, preserve affinity, and expose detached active counts', async () => {
  const f = fixture()
  const counts = new Map<string, number>()
  const bindings = new Map<string, string>()
  for (let i = 0; i < 120; i++) {
    const lease = await f.scheduler.acquire({ sessionId: `session-${i}` })
    bindings.set(`session-${i}`, lease.accountId)
    counts.set(lease.accountId, (counts.get(lease.accountId) ?? 0) + 1)
    assert.equal(lease.accountName, `Account ${lease.accountId}`)
    assert.equal(lease.authToken, secret)
    const active = f.scheduler.activeCounts()
    assert.deepEqual(active, { [lease.accountId]: 1 })
    active[lease.accountId] = 99
    assert.equal(f.scheduler.activeCounts()[lease.accountId], 1)
    lease.release(); lease.release()
  }
  assert.deepEqual(Object.fromEntries(counts), { a: 40, b: 40, c: 40 })
  for (let i = 119; i >= 0; i--) {
    const lease = await f.scheduler.acquire({ sessionId: `session-${i}` })
    assert.equal(lease.accountId, bindings.get(`session-${i}`))
    lease.release()
  }
  assert.deepEqual(f.scheduler.activeCounts(), {})
  assert.equal(f.reads.length, 240, 'each lease reads fresh credentials exactly once')
})

test('concurrent requests share a session binding and wait until caller cleanup releases it', async () => {
  const f = fixture()
  const first = await f.scheduler.acquire({ sessionId: 'same' })
  let granted = false
  const next = f.scheduler.acquire({ sessionId: 'same' }).then(lease => { granted = true; return lease })
  const other = await f.scheduler.acquire({ sessionId: 'other' })
  assert.notEqual(other.accountId, first.accountId)
  await tick()
  assert.equal(granted, false)
  assert.deepEqual(f.reads, ['a', 'b'])
  first.release()
  const second = await next
  assert.equal(second.accountId, first.accountId)
  second.release(); other.release()
  assert.deepEqual(f.scheduler.activeCounts(), {})
})

for (const maxAffinity of [0, 1]) test(`active affinity survives idle LRU eviction (capacity ${maxAffinity})`, async () => {
  const f = fixture({ maxAffinity })
  f.set({ mode: 'pool', accounts: ['a', 'b'].map(account) })
  const first = await f.scheduler.acquire({ sessionId: 'one' })
  const other = await f.scheduler.acquire({ sessionId: 'two' }); other.release()
  const thirdPending = f.scheduler.acquire({ sessionId: 'three' })
  let granted = false
  const againPending = f.scheduler.acquire({ sessionId: 'one' }).then(lease => { granted = true; return lease })
  await tick(); await tick()
  assert.equal(granted, false)
  first.release()
  const third = await thirdPending; third.release()
  const again = await againPending
  assert.equal(again.accountId, first.accountId); again.release()
  assert.deepEqual(f.scheduler.activeCounts(), {})
})

test('parallel bursts respect configurable per-account limits and run each acquisition only once', async () => {
  const f = fixture({ maxPerAccount: 2 })
  const started: AccountLease[] = []
  const pending = Array.from({ length: 60 }, (_, i) => f.scheduler.acquire({ sessionId: `s-${i}` }).then(async lease => {
    started.push(lease)
    for (const count of Object.values(f.scheduler.activeCounts())) assert.ok(count <= 2)
    await tick()
    lease.release()
    return lease.accountId
  }))
  const ids = await Promise.all(pending)
  assert.deepEqual(ids.reduce<Record<string, number>>((counts, id) => { counts[id] = (counts[id] ?? 0) + 1; return counts }, {}), { a: 20, b: 20, c: 20 })
  assert.equal(started.length, 60)
  assert.equal(f.reads.length, 60)
  assert.deepEqual(f.scheduler.activeCounts(), {})
})

test('fixed mode rejects missing, disabled, removed and auth-required selections without fallback', async () => {
  const states: Array<[AccountSnapshot, RegExp]> = [
    [{ mode: 'fixed', accounts: [account('b')] }, /No fixed account/],
    [{ mode: 'fixed', selectedAccountId: 'a', accounts: [account('b')] }, /missing|removed/],
    [{ mode: 'fixed', selectedAccountId: 'a', accounts: [{ ...account('a'), enabled: false }, account('b')] }, /disabled/],
    [{ mode: 'fixed', selectedAccountId: 'a', accounts: [{ ...account('a'), authState: 'auth-required' }, account('b')] }, /authentication/],
    [{ mode: 'pool', managed: false, accounts: [account('b')] }, /not enabled/],
  ]
  for (const [state, pattern] of states) {
    const f = fixture(); f.set(state)
    await assert.rejects(f.scheduler.acquire(), safeError('AccountSelectionError', pattern))
    assert.deepEqual(f.reads, [])
  }
})

test('pool excludes disabled and auth-required accounts; only explicit model denial excludes unknown models', async () => {
  const f = fixture({ isModelAllowed: (item, model) => item.id === 'c' && model === 'denied' ? false : undefined })
  f.set({ mode: 'pool', accounts: [{ ...account('a'), enabled: false }, { ...account('b'), authState: 'auth-required' }, account('c')] })
  const lease = await f.scheduler.acquire({ model: 'unknown-model' })
  assert.equal(lease.accountId, 'c'); lease.release()
  await assert.rejects(f.scheduler.acquire({ model: 'denied' }), safeError('AccountSelectionError', /No eligible/))
  f.set({ mode: 'fixed', selectedAccountId: 'c', accounts: [account('c')] })
  await assert.rejects(f.scheduler.acquire({ model: 'denied' }), safeError('AccountSelectionError', /does not allow/))
})

test('queue is capped at 64, abort reasons are sanitized, and queued credentials are not read', async () => {
  const f = fixture(); f.set({ mode: 'fixed', selectedAccountId: 'a', accounts: [account('a')] })
  const first = await f.scheduler.acquire()
  const controllers = Array.from({ length: 64 }, () => new AbortController())
  const queued = controllers.map(controller => assert.rejects(f.scheduler.acquire({ signal: controller.signal }), safeError('AbortError')))
  await assert.rejects(f.scheduler.acquire(), safeError('QueueFullError'))
  await tick()
  assert.equal(f.reads.length, 1)
  controllers.forEach(controller => controller.abort(new Error(secret)))
  await Promise.all(queued)
  const already = new AbortController(); already.abort(secret)
  await assert.rejects(f.scheduler.acquire({ signal: already.signal }), safeError('AbortError'))
  assert.deepEqual(f.scheduler.activeCounts(), { a: 1 })
  first.release()
  const next = await f.scheduler.acquire(); next.release()
  assert.deepEqual(f.scheduler.activeCounts(), {})
})

test('queue timeout uses its live getter, removes waiters and never reads or retries their credentials', async () => {
  let timeout = 1000
  const f = fixture({ queueTimeoutMs: () => timeout })
  f.set({ mode: 'fixed', selectedAccountId: 'a', accounts: [account('a')] })
  const first = await f.scheduler.acquire()
  timeout = 15
  await assert.rejects(f.scheduler.acquire(), safeError('QueueTimeoutError'))
  assert.equal(f.reads.length, 1)
  first.release(); await tick()
  assert.equal(f.reads.length, 1)
  timeout = 1000
  const next = await f.scheduler.acquire(); next.release()
})

test('refresh rejects queued choices when disabled, removed, auth-required or mode/selection changed', async () => {
  for (const state of [
    { mode: 'fixed', selectedAccountId: 'a', accounts: [{ ...account('a'), enabled: false }, account('b')] },
    { mode: 'fixed', selectedAccountId: 'a', accounts: [account('b')] },
    { mode: 'fixed', selectedAccountId: 'a', accounts: [{ ...account('a'), authState: 'auth-required' }, account('b')] },
    { mode: 'fixed', selectedAccountId: 'b', accounts: [account('a'), account('b')] },
    { mode: 'pool', accounts: [account('a'), account('b')] },
  ] satisfies AccountSnapshot[]) {
    const f = fixture(); f.set({ mode: 'fixed', selectedAccountId: 'a', accounts: [account('a'), account('b')] })
    const first = await f.scheduler.acquire()
    const rejected = assert.rejects(f.scheduler.acquire(), safeError('AccountSelectionError'))
    await tick()
    f.set(state)
    await rejected
    assert.deepEqual(f.scheduler.activeCounts(), { a: 1 }, 'refresh must not release active caller leases')
    assert.deepEqual(f.reads, ['a'])
    first.release()
  }
})

test('grant-time revalidation detects changes even without explicit refresh', async () => {
  const f = fixture(); f.set({ mode: 'fixed', selectedAccountId: 'a', accounts: [account('a')] })
  const first = await f.scheduler.acquire()
  const rejected = assert.rejects(f.scheduler.acquire(), safeError('AccountSelectionError', /disabled/))
  await tick()
  f.state().accounts[0]!.enabled = false
  first.release()
  await rejected
  assert.deepEqual(f.reads, ['a'])
})

test('refresh invalidates a credential read already in flight; no identity fallback or slot leaks', async () => {
  const read = deferred<typeof credential | undefined>()
  const f = fixture({ readCredential: () => read.promise })
  const rejected = assert.rejects(f.scheduler.acquire(), safeError('AccountSelectionError'))
  await tick()
  assert.deepEqual(f.scheduler.activeCounts(), { a: 1 })
  f.set({ mode: 'pool', accounts: [account('b'), account('c')] })
  await rejected
  assert.deepEqual(f.scheduler.activeCounts(), {})
  read.resolve(credential); await tick()
  assert.deepEqual(f.scheduler.activeCounts(), {})
})

test('stale asynchronous snapshots cannot grant after refresh', async () => {
  const old = deferred<AccountSnapshot>()
  let calls = 0
  const scheduler = new AccountScheduler({
    snapshot: async () => ++calls === 1 ? old.promise : { mode: 'fixed', selectedAccountId: 'a', accounts: [{ ...account('a'), enabled: false }] },
    readCredential: async () => { assert.fail('disabled account must not read credentials') },
  })
  const rejected = assert.rejects(scheduler.acquire(), safeError('AccountSelectionError', /disabled/))
  scheduler.refresh()
  old.resolve({ mode: 'fixed', selectedAccountId: 'a', accounts: [account('a')] })
  await rejected
  assert.ok(calls >= 2)
})

test('credential missing, invalid or thrown errors fail the chosen account with no fallback or retry', async () => {
  for (const result of [undefined, { accessToken: '', uid: 'u' }, { accessToken: secret, uid: '' }, { accessToken: 'bad\n' + secret, uid: 'u' }, new Error(secret)]) {
    const reads: string[] = []
    const f = fixture({ readCredential: async id => { reads.push(id); if (result instanceof Error) throw result; return result } })
    await assert.rejects(f.scheduler.acquire(), safeError('AccountCredentialError'))
    assert.deepEqual(reads, ['a'])
    assert.deepEqual(f.scheduler.activeCounts(), {})
    await tick(); assert.deepEqual(reads, ['a'])
  }
})

test('snapshot, timeout and model callback errors never propagate secrets or causes', async () => {
  for (const [options, name] of [
    [{ snapshot: async () => { throw new Error(secret) } }, 'AccountSnapshotError'],
    [{ queueTimeoutMs: () => { throw new Error(secret) } }, 'AccountConfigurationError'],
    [{ isModelAllowed: () => { throw new Error(secret) } }, 'AccountModelError'],
    [{ readCredential: async () => ({ get accessToken(): string { throw new Error(secret) }, uid: 'u' }) }, 'AccountCredentialError'],
  ] satisfies Array<[Partial<AccountSchedulerOptions>, string]>) {
    const f = fixture(options)
    await assert.rejects(f.scheduler.acquire({ model: 'unknown' }), safeError(name))
    assert.deepEqual(f.scheduler.activeCounts(), {})
  }
})

test('abort/timeout during credential lookup free capacity and ignore late credentials', async () => {
  for (const abort of [true, false]) {
    const read = deferred<typeof credential>()
    let calls = 0
    const f = fixture({ queueTimeoutMs: () => abort ? 1000 : 15, readCredential: async () => ++calls === 1 ? read.promise : credential })
    f.set({ mode: 'fixed', selectedAccountId: 'a', accounts: [account('a')] })
    const controller = new AbortController()
    const rejected = assert.rejects(f.scheduler.acquire({ signal: controller.signal }), safeError(abort ? 'AbortError' : 'QueueTimeoutError'))
    await tick()
    if (abort) controller.abort(secret)
    await rejected
    assert.deepEqual(f.scheduler.activeCounts(), {})
    const next = await f.scheduler.acquire()
    read.resolve(credential); await tick()
    assert.deepEqual(f.scheduler.activeCounts(), { a: 1 })
    next.release()
    assert.equal(calls, 2)
    assert.deepEqual(f.scheduler.activeCounts(), {})
  }
})

test('slow credentials on one account do not block other accounts', async () => {
  const read = deferred<typeof credential>()
  const f = fixture({ readCredential: async id => id === 'a' ? read.promise : credential })
  const slow = f.scheduler.acquire({ sessionId: 'slow' })
  const fast = await f.scheduler.acquire({ sessionId: 'fast' })
  assert.equal(fast.accountId, 'b')
  read.resolve(credential)
  const first = await slow
  first.release(); fast.release()
})

test('bounded LRU bindings retain recently used sessions and prune ineligible accounts', async () => {
  const f = fixture({ maxAffinity: 2 })
  const run = async (sessionId: string) => { const lease = await f.scheduler.acquire({ sessionId }); lease.release(); return lease.accountId }
  assert.equal(await run('one'), 'a')
  assert.equal(await run('two'), 'b')
  assert.equal(await run('one'), 'a', 'touch one, so two is oldest')
  assert.equal(await run('three'), 'c')
  assert.equal(await run('one'), 'a')
  assert.equal(await run('two'), 'a', 'evicted two is assigned as a new session')
  // Inspect only map sizes; no testing-only API is added to the scheduler contract.
  const maps = f.scheduler as unknown as { affinity: Map<string, string>; active: Map<string, number>; queue: unknown[] }
  for (let i = 0; i < 200; i++) await run(`new-${i}`)
  assert.equal(maps.affinity.size, 2)
  assert.equal(maps.active.size, 0)
  assert.equal(maps.queue.length, 0)
  f.set({ mode: 'pool', accounts: [{ ...account('a'), enabled: false }, account('b')] })
  assert.equal(await run('new-199'), 'b')
  assert.ok([...maps.affinity.values()].every(id => id === 'b'))
})

test('snapshot/account/request inputs are copied and fresh credentials are read per lease', async () => {
  let token = 'first-token'
  const f = fixture({ readCredential: async () => ({ accessToken: token, uid: 'u' }) })
  const request = { sessionId: 'original' }
  const pending = f.scheduler.acquire(request)
  request.sessionId = 'mutated'
  const first = await pending; assert.equal(first.authToken, 'first-token'); first.release()
  token = 'second-token'
  const second = await f.scheduler.acquire({ sessionId: 'original' })
  assert.equal(second.accountId, first.accountId)
  assert.equal(second.authToken, 'second-token')
  second.release()
  assert.ok(!JSON.stringify(f.scheduler.activeCounts()).includes(token))
})

test('simultaneous first requests bind once and preserve per-account FIFO', async () => {
  const f = fixture()
  const order: number[] = []
  const ids = await Promise.all(Array.from({ length: 32 }, (_, i) => f.scheduler.acquire({ sessionId: 'new-session' }).then(async lease => {
    order.push(i)
    await tick()
    lease.release()
    return lease.accountId
  })))
  assert.deepEqual(ids, Array.from({ length: 32 }, () => 'a'))
  assert.deepEqual(order, Array.from({ length: 32 }, (_, i) => i))
  assert.equal(f.reads.length, 32)
})

test('grant rechecks selection after credentials resolve even without refresh notification', async () => {
  const read = deferred<typeof credential>()
  const f = fixture({ readCredential: () => read.promise })
  f.set({ mode: 'fixed', selectedAccountId: 'a', accounts: [account('a'), account('b')] })
  const rejected = assert.rejects(f.scheduler.acquire(), safeError('AccountSelectionError', /changed/))
  await tick()
  f.state().selectedAccountId = 'b'
  read.resolve(credential)
  await rejected
  assert.deepEqual(f.scheduler.activeCounts(), {})
})

test('aborts synchronously triggered by eligibility callbacks never reserve or grant slots', async () => {
  for (const abortAt of [1, 3]) {
    const controller = new AbortController()
    let calls = 0
    const f = fixture({ isModelAllowed: () => { if (++calls === abortAt) controller.abort(secret); return true } })
    f.set({ mode: 'fixed', selectedAccountId: 'a', accounts: [account('a')] })
    await assert.rejects(f.scheduler.acquire({ signal: controller.signal, model: 'model' }), safeError('AbortError'))
    assert.deepEqual(f.scheduler.activeCounts(), {})
  }
})

test('invalid capacities/timeouts and malformed account snapshots fail safely', async () => {
  for (const maxPerAccount of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => fixture({ maxPerAccount }), safeError('AccountConfigurationError'))
  }
  for (const maxAffinity of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => fixture({ maxAffinity }), safeError('AccountConfigurationError'))
  }
  for (const timeout of [0, -1, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(fixture({ queueTimeoutMs: () => timeout }).scheduler.acquire(), safeError('AccountConfigurationError'))
  }
  const f = fixture({ snapshot: async () => ({ mode: 'pool', accounts: [account('a'), account('a')] }) })
  await assert.rejects(f.scheduler.acquire(), safeError('AccountSnapshotError'))
})
