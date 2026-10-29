import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountAuthManager, AccountStore, MAX_ACCOUNTS } from '../src/accounts.ts'

const secret = 'synthetic-token-DO-NOT-LEAK'
const credential = { accessToken: secret, uid: 'private-full-user-identifier' }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cb-accounts-')), path = join(dir, 'private', 'accounts.json')
  return { dir, path, store: new AccountStore(path), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
function response(data: unknown): Response { return new Response(JSON.stringify({ code: 0, data })) }
const stateResponse = () => response({ state: 'private-state', authUrl: 'https://www.codebuddy.cn/login?state=private-state' })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('legacy credentials migrate once without modifying legacy; empty managed state remains sticky across restart', async () => {
  const f = fixture()
  try {
    assert.equal(f.store.hasManagedAccounts(), false)
    assert.deepEqual(f.store.snapshot(), { mode: 'fixed', accounts: [] })
    mkdirSync(join(f.dir, 'private'))
    const legacy = JSON.stringify({ ...credential, refreshToken: 'discard-me' })
    writeFileSync(f.store.legacyPath, legacy)
    const [account] = f.store.list()
    assert.ok(account)
    assert.deepEqual(await f.store.read(account.id), credential)
    assert.equal(f.store.snapshot().selectedAccountId, account.id)
    assert.equal(readFileSync(f.store.legacyPath, 'utf8'), legacy)
    assert.equal(readFileSync(f.path, 'utf8').includes('discard-me'), false)
    assert.equal(f.store.hasManagedAccounts(), true)
    await f.store.remove(account.id)
    const reopened = new AccountStore(f.path)
    assert.equal(reopened.hasManagedAccounts(), true)
    assert.deepEqual(reopened.list(), [])
    assert.equal(readFileSync(f.store.legacyPath, 'utf8'), legacy)
    await reopened.clear()
    assert.equal(new AccountStore(f.path).hasManagedAccounts(), true)
  } finally { f.cleanup() }
})

test('duplicate UID updates in place, target UID mismatch preserves disk, metadata never discloses UID or token', async () => {
  const f = fixture()
  try {
    const first = await f.store.upsert(credential)
    const updated = await f.store.update(first.id, { name: '  Personal  ', enabled: false })
    assert.equal(updated.name, 'Personal')
    await f.store.markAuthRequired(first.id)
    assert.equal(f.store.list()[0]?.authState, 'auth-required')
    const replacement = await f.store.upsert({ ...credential, accessToken: 'new-token' })
    assert.equal(replacement.id, first.id)
    assert.equal(replacement.enabled, false)
    assert.equal(replacement.name, 'Personal')
    assert.equal(replacement.createdAt, first.createdAt)
    assert.equal(replacement.authState, 'ready')
    assert.equal(f.store.list().length, 1)
    const before = readFileSync(f.path, 'utf8'), revision = f.store.revision
    await assert.rejects(f.store.upsert({ accessToken: 'other-token', uid: 'other-user' }, first.id), /same CodeBuddy account/)
    await assert.rejects(f.store.upsert(credential, 'missing'), /does not exist/)
    assert.equal(readFileSync(f.path, 'utf8'), before)
    assert.equal(f.store.revision, revision)
    for (const value of [first, updated, replacement, f.store.list(), f.store.snapshot()]) {
      const publicJSON = JSON.stringify(value)
      assert.equal(publicJSON.includes(secret), false)
      assert.equal(publicJSON.includes(credential.uid), false)
      assert.equal(publicJSON.includes('accessToken'), false)
      assert.equal(publicJSON.includes('credential'), false)
    }
    assert.deepEqual(Object.keys(first).sort(), ['authState', 'createdAt', 'enabled', 'id', 'name'])
    const read = await f.store.read(first.id)
    assert.ok(read); read.uid = 'mutated'
    assert.equal((await f.store.read(first.id))?.uid, credential.uid)
  } finally { f.cleanup() }
})

test('configuration is validated atomically, never silently switches selected account', async () => {
  const f = fixture()
  try {
    const first = await f.store.upsert(credential)
    const second = await f.store.upsert({ accessToken: 'second-token', uid: 'second-user' })
    assert.equal(f.store.snapshot().selectedAccountId, first.id)
    await f.store.configure({ mode: 'fixed', accountId: second.id })
    assert.equal(new AccountStore(f.path).snapshot().selectedAccountId, second.id)
    await f.store.update(first.id, { enabled: false })
    for (const config of [{ mode: 'fixed', accountId: first.id }, { mode: 'fixed', accountId: 'missing' }, { mode: 'pool', accountId: second.id }, { mode: 'bad' }]) {
      const before = readFileSync(f.path, 'utf8'), revision = f.store.revision
      await assert.rejects(f.store.configure(config as Parameters<AccountStore['configure']>[0]))
      assert.equal(readFileSync(f.path, 'utf8'), before)
      assert.equal(f.store.revision, revision)
    }
    await f.store.update(second.id, { enabled: false })
    assert.equal(f.store.snapshot().selectedAccountId, undefined)
    await f.store.configure({ mode: 'pool' })
    assert.equal(f.store.snapshot().mode, 'pool')
    await f.store.update(first.id, { enabled: true })
    await f.store.configure({ mode: 'fixed', accountId: first.id })
    await f.store.remove(first.id)
    assert.equal(f.store.snapshot().selectedAccountId, undefined)
  } finally { f.cleanup() }
})

test('private bounded atomic persistence; invalid writes do not mutate state or leave secret temporaries', async () => {
  const f = fixture()
  try {
    const row = await f.store.upsert(credential), revision = f.store.revision
    assert.deepEqual(readdirSync(join(f.dir, 'private')), ['accounts.json'])
    if (process.platform !== 'win32') {
      assert.equal(statSync(f.path).mode & 0o777, 0o600)
      assert.equal(statSync(join(f.dir, 'private')).mode & 0o777, 0o700)
    }
    for (const patch of [{ name: '' }, { name: 'x\ny' }, { name: 'x'.repeat(101) }, { enabled: 'yes' }, { accessToken: secret }]) {
      await assert.rejects(f.store.update(row.id, patch as Parameters<AccountStore['update']>[1]))
    }
    await assert.rejects(f.store.upsert({ ...credential, enterpriseId: 'corp' } as typeof credential))
    assert.equal(f.store.revision, revision)
    for (let index = 1; index < MAX_ACCOUNTS; index++) await f.store.upsert({ accessToken: secret, uid: `user-${index}` })
    const before = readFileSync(f.path, 'utf8')
    await assert.rejects(f.store.upsert({ accessToken: secret, uid: 'too-many' }), /limit/)
    assert.equal(readFileSync(f.path, 'utf8'), before)
    await f.store.upsert(credential)
    assert.equal(f.store.list().length, MAX_ACCOUNTS)
  } finally { f.cleanup() }
})

test('corrupt/oversized/unreadable account files fail closed and never fall back to legacy', async () => {
  const f = fixture()
  try {
    const row = await f.store.upsert(credential)
    writeFileSync(f.store.legacyPath, JSON.stringify(credential))
    const valid = JSON.parse(readFileSync(f.path, 'utf8')) as Record<string, unknown>
    for (const data of [secret, ' '.repeat(512 * 1024 + 1), JSON.stringify({ ...valid, unexpected: true }),
      JSON.stringify({ ...valid, selectedAccountId: 'missing' }), JSON.stringify({ ...valid, accounts: [{ broken: true }] }),
      JSON.stringify({ ...valid, accounts: [...valid.accounts as unknown[], ...valid.accounts as unknown[]] })]) {
      writeFileSync(f.path, data)
      await assert.rejects(f.store.read(row.id), error => error instanceof Error && !error.message.includes(secret))
      assert.throws(() => f.store.list())
      assert.throws(() => f.store.hasManagedAccounts())
      await assert.rejects(f.store.upsert(credential))
      assert.equal(readFileSync(f.path, 'utf8'), data)
    }
    unlinkSync(f.path)
    assert.throws(() => f.store.hasManagedAccounts())
    mkdirSync(f.path)
    await assert.rejects(new AccountStore(f.path).read(row.id))
  } finally { f.cleanup() }
})

test('invalid legacy data is not overwritten or hidden by a new login', async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.dir, 'private')); writeFileSync(f.store.legacyPath, secret)
    assert.throws(() => f.store.list())
    await assert.rejects(f.store.upsert(credential))
    assert.equal(readFileSync(f.store.legacyPath, 'utf8'), secret)
    assert.equal(existsSync(f.path), false)
  } finally { f.cleanup() }
})

test('existing accounts take precedence without touching unrelated legacy', async () => {
  const f = fixture()
  try {
    const row = await f.store.upsert(credential)
    writeFileSync(f.store.legacyPath, 'broken legacy data')
    assert.equal(new AccountStore(f.path).list()[0]?.id, row.id)
    assert.equal(readFileSync(f.store.legacyPath, 'utf8'), 'broken legacy data')
  } finally { f.cleanup() }
})

test('hard-linked files and symlinked parent directories cannot be read or overwritten', async () => {
  const f = fixture()
  try {
    const row = await f.store.upsert(credential)
    const original = readFileSync(f.path, 'utf8'), external = join(f.dir, 'external.json')
    linkSync(f.path, external)
    await assert.rejects(f.store.read(row.id))
    await assert.rejects(f.store.upsert(credential))
    assert.equal(readFileSync(external, 'utf8'), original)
    unlinkSync(external)
    const linked = join(f.dir, 'linked')
    symlinkSync(join(f.dir, 'private'), linked, process.platform === 'win32' ? 'junction' : 'dir')
    const unsafe = new AccountStore(join(linked, 'accounts.json'))
    await assert.rejects(unsafe.read(row.id))
    await assert.rejects(unsafe.upsert(credential))
    assert.equal(readFileSync(f.path, 'utf8'), original)
  } finally { f.cleanup() }
})

test('leaf symlinks never redirect reads or writes', { skip: process.platform === 'win32' }, async () => {
  const f = fixture()
  try {
    const row = await f.store.upsert(credential)
    const original = readFileSync(f.path, 'utf8'), external = join(f.dir, 'external.json')
    writeFileSync(external, original)
    unlinkSync(f.path); symlinkSync(external, f.path)
    await assert.rejects(f.store.read(row.id))
    await assert.rejects(f.store.upsert(credential))
    assert.equal(readFileSync(external, 'utf8'), original)
  } finally { f.cleanup() }
})

test('store revisions survive restart and stale disk revisions fail closed', async () => {
  const f = fixture()
  try {
    const row = await f.store.upsert(credential), old = readFileSync(f.path, 'utf8'), revision = f.store.revision
    await f.store.update(row.id, { name: 'Renamed' })
    assert.ok(f.store.revision > revision)
    assert.equal(new AccountStore(f.path).revision, f.store.revision)
    writeFileSync(f.path, old)
    await assert.rejects(f.store.read(row.id))
    await assert.rejects(f.store.clear())
    assert.equal(readFileSync(f.path, 'utf8'), old)
  } finally { f.cleanup() }
})

test('OAuth adds, deduplicates, reauthorizes same UID only, and returns no credential', async () => {
  const f = fixture()
  let uid = credential.uid
  const manager = new AccountAuthManager(f.store, { fetch: async url => String(url).includes('/auth/state') ? stateResponse() :
    String(url).includes('/auth/token') ? response({ accessToken: secret }) : response({ accounts: [{ uid }] }) })
  try {
    const first = await manager.start()
    assert.deepEqual(await manager.poll(first.flowId), { status: 'ok' })
    const [account] = f.store.list(); assert.ok(account)
    const duplicate = await manager.start()
    await manager.poll(duplicate.flowId)
    assert.equal(f.store.list().length, 1)
    await f.store.markAuthRequired(account.id)
    const wrong = await manager.start(account.id)
    uid = 'different-user'
    await assert.rejects(manager.poll(wrong.flowId), /same CodeBuddy account/)
    assert.equal(f.store.list()[0]?.authState, 'auth-required')
    uid = credential.uid
    const reauth = await manager.start(account.id)
    assert.deepEqual(await manager.poll(reauth.flowId), { status: 'ok' })
    assert.equal(f.store.list()[0]?.authState, 'ready')
    assert.deepEqual(await manager.poll(reauth.flowId), { status: 'ok' })
    await assert.rejects(manager.start('missing'), /does not exist/)
    assert.equal(f.store.list().length, 1)
  } finally { manager.cancelAll(); f.cleanup() }
})

test('OAuth cancel/remove/clear/replacement/reconfiguration fences late results', async () => {
  for (const action of ['cancel', 'remove', 'clear', 'replace', 'configure'] as const) {
    const f = fixture(), gate = deferred<Response>(), entered = deferred<void>()
    const row = await f.store.upsert(credential)
    const manager = new AccountAuthManager(f.store, { fetch: async url => {
      if (String(url).includes('/auth/state')) return stateResponse()
      if (String(url).includes('/auth/token')) return response({ accessToken: 'late-token' })
      entered.resolve(); return gate.promise
    } })
    try {
      const flow = await manager.start(row.id), pending = manager.poll(flow.flowId), rejected = assert.rejects(pending)
      await entered.promise
      if (action === 'cancel') manager.cancel(flow.flowId)
      if (action === 'remove') await f.store.remove(row.id)
      if (action === 'clear') await f.store.clear()
      if (action === 'replace') await manager.start()
      if (action === 'configure') await f.store.configure({ mode: 'pool' })
      gate.resolve(response({ accounts: [{ uid: credential.uid }] }))
      await rejected
      assert.equal((await f.store.read(row.id))?.accessToken, action === 'remove' || action === 'clear' ? undefined : secret)
      assert.equal(f.store.hasManagedAccounts(), true)
    } finally { manager.cancelAll(); f.cleanup() }
  }
})

test('clear/remove while OAuth starts cannot publish a late flow, including another store instance', async () => {
  for (const clear of [false, true]) {
    const f = fixture(), gate = deferred<Response>()
    const row = await f.store.upsert(credential)
    const manager = new AccountAuthManager(f.store, { fetch: async () => gate.promise })
    try {
      const pending = manager.start(row.id), rejected = assert.rejects(pending)
      const other = new AccountStore(f.path)
      if (clear) await other.clear(); else await other.remove(row.id)
      gate.resolve(stateResponse()); await rejected
      assert.deepEqual(f.store.list(), [])
    } finally { manager.cancelAll(); f.cleanup() }
  }
})
