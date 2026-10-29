import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountRefresher } from '../src/credits.ts'

const login = { auth: { accessToken: 'fictional-secret-token', tokenType: 'Bearer' }, account: { uid: 'fictional-user' } }
const row = (total = 100, remaining = 25) => ({ total, remaining })
function mock(pages: unknown[], status = 200) {
  const calls: {url: string; init: RequestInit}[] = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({url: String(url), init: init!})
    return new Response(JSON.stringify(pages[Math.min(calls.length - 1, pages.length - 1)]), { status })
  }
  return {fetch, calls}
}
const resources = (rows: unknown[]) => ({ code: 0, data: {resources: rows} })
const accounts = (Accounts: unknown[], TotalCount?: number | string) => ({code: 0, data: {Response: {Data: {Accounts, ...(TotalCount === undefined ? {} : {TotalCount})}}}})
const grant = (id: number, total = 100, remaining = 25) => ({ResourceId: `grant-${id}`, PackageCode: 'TCACA_code_009_0XmEQc2xOf', CycleCapacitySizePrecise: String(total), CycleCapacityRemainPrecise: String(remaining)})
const fullPage = (start = 0) => Array.from({length:100}, (_, index) => grant(start + index))

test('compatibility-version rejection never becomes a quota or credential retry', async () => {
  for (const status of [200,400]) {
    const api = mock([{code:12403,message:'PRIVATE version rejected'}],status)
    const value = await createAccountRefresher({fetch:api.fetch,readCredentials:async () => login})()
    assert.notEqual(value.status,'ok'); assert.notEqual(value.status,'auth-required')
    assert.equal(value.remaining,undefined); assert.equal(api.calls.length,1)
    assert.doesNotMatch(JSON.stringify(value),/PRIVATE/)
  }
})

test('explicit credential file is read-only, reread on refresh and bounded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-credentials-'))
  const path = join(dir, 'session.json')
  try {
    const contents = JSON.stringify(login)
    await writeFile(path, contents, {mode:0o600})
    const before = await stat(path)
    const api = mock([resources([row()]), resources([])])
    const refresh = createAccountRefresher({credentialsFile:path, fetch:api.fetch})
    assert.equal((await refresh()).remaining,25)
    assert.equal(await readFile(path,'utf8'),contents)
    assert.equal((await stat(path)).mtimeMs,before.mtimeMs)
    await writeFile(path, '{invalid')
    assert.equal((await refresh()).status,'unavailable')
    assert.equal(api.calls.length,1)
    await writeFile(path, ' '.repeat(65537))
    assert.equal((await refresh()).status,'unavailable')
    assert.equal(api.calls.length,1)
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('real Accounts short page terminates without probing a repeated tail and matches reference request', async () => {
  const api = mock([accounts([grant(1, 100, 0)])])
  const refresh = createAccountRefresher({ fetch: api.fetch, readCredentials: async () => login, now: () => new Date('2026-01-01T00:00:00Z') })
  assert.deepEqual(await refresh(), {status:'ok', total:100, remaining:0, used:100, unit:'积分', source:'CodeBuddy 中国区（实验性只读查询）', updatedAt:'2026-01-01T00:00:00.000Z'})
  assert.equal(api.calls.length, 1)
  for (const [index, call] of api.calls.entries()) {
    assert.equal(call.url, 'https://www.codebuddy.cn/v2/billing/meter/get-user-resource')
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.method, 'POST')
    assert.ok(call.init.signal instanceof AbortSignal)
    assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer fictional-secret-token')
    assert.equal(new Headers(call.init.headers).get('x-user-id'), 'fictional-user')
    assert.equal(new Headers(call.init.headers).get('user-agent'), 'CLI/2.63.2 CodeBuddy/2.63.2')
    const body = JSON.parse(call.init.body as string)
    assert.equal(body.PageNumber, index + 1)
    assert.equal(body.PageSize, 100)
    assert.equal(body.ProductCode, 'p_tcaca')
    assert.deepEqual(body.Status, [0, 3])
    const now = new Date('2026-01-01T00:00:00Z')
    const pad = (n: number) => String(n).padStart(2, '0')
    assert.equal(body.PackageEndTimeRangeBegin, `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`)
    assert.equal(body.PackageEndTimeRangeEnd, `${now.getFullYear()+100}-${pad(now.getMonth()+1)}-${pad(now.getDate())} 00:00:00`)
    assert.equal(new Headers(call.init.headers).get('user-agent'), 'CLI/2.63.2 CodeBuddy/2.63.2')
    assert.ok(!JSON.stringify(body).includes(login.auth.accessToken))
  }
})
test('full Accounts page continues to a short final page without double counting', async () => {
  const api = mock([accounts(fullPage()), accounts([grant(100, 20, 5)])])
  const status = await createAccountRefresher({fetch:api.fetch, readCredentials:async () => login})()
  assert.equal(status.total, 10020); assert.equal(status.remaining, 2505); assert.equal(status.used, 7515)
  assert.deepEqual(api.calls.map(call => JSON.parse(call.init.body as string).PageNumber), [1, 2])
})
test('explicit TotalCount terminates a full page or continues a server-capped short page', async () => {
  for (const [pages, expectedCalls, total] of [
    [[accounts(fullPage(), '100')], 1, 10000],
    [[accounts([grant(1)], 2), accounts([grant(2)], 2)], 2, 200],
    [[accounts(fullPage()), accounts([])], 2, 10000],
  ] as const) {
    const api = mock([...pages])
    const status = await createAccountRefresher({fetch:api.fetch, readCredentials:async () => login})()
    assert.equal(status.status, 'ok'); assert.equal(status.total, total); assert.equal(api.calls.length, expectedCalls)
  }
})
test('all resource types and equal-valued grants accumulate with reference field precedence', async () => {
  const grants = [
    {...grant(1, 100, 10), PackageCode:'TCACA_code_002_AkiJS3ZHF5', CycleCapacitySize:999, CycleCapacityRemain:999},
    {PackageCode:'TCACA_code_008_cfWoLwvjU4', CycleCapacitySizePrecise:'unavailable', CycleCapacitySize:' 20 ', CycleCapacityRemain:'2e0', CapacitySizePrecise:999, CapacityRemainPrecise:999},
    {PackageCode:'TCACA_code_007_nzdH5h4Nl0', CapacitySizePrecise:'30.5', CapacityRemainPrecise:'3.5', Status:7},
    {PackageCode:'TCACA_code_009_0XmEQc2xOf', CapacitySize:40, CapacityRemain:4},
    {PackageName:'CodeBuddy 个人版拉新权益包', CapacitySize:50, CapacityRemain:5},
    {PackageName:'CodeBuddy 个人版拉新权益包', CapacitySize:50, CapacityRemain:5},
  ]
  const api = mock([accounts(grants)])
  const status = await createAccountRefresher({fetch:api.fetch, readCredentials:async () => login})()
  assert.equal(status.status,'ok'); assert.equal(status.total,290.5); assert.equal(status.remaining,29.5); assert.equal(status.used,261)
  assert.equal(api.calls.length,1)
})
test('Accounts envelopes are optional at every reference layer', async () => {
  const Accounts = [grant(1)]
  for (const payload of [{Accounts}, {Data:{Accounts}}, {Response:{Data:{Accounts}}}, {data:{Accounts}}, accounts(Accounts)]) {
    const api = mock([payload])
    assert.equal((await createAccountRefresher({fetch:api.fetch, readCredentials:async () => login})()).remaining,25)
  }
})
test('precise legacy cycle fields accept strings including zero', async () => {
  const envelope = (Accounts: unknown[]) => ({data:{Response:{Data:{Accounts}}}})
  const api = mock([envelope([{Status:3, CycleCapacitySizePrecise:'0', CycleCapacityRemainPrecise:'0'}]), envelope([])])
  const status = await createAccountRefresher({fetch:api.fetch, readCredentials:async () => login})()
  assert.equal(status.status, 'ok'); assert.equal(status.total, 0); assert.equal(status.remaining, 0)
})
test('repeated pages and unbounded paging do not report partial balances', async () => {
  for (const pages of [[accounts(fullPage())], Array.from({length:5}, (_, i) => accounts(fullPage(i * 100)))]) {
    const api = mock(pages)
    const status = await createAccountRefresher({fetch:api.fetch, readCredentials:async () => login})()
    assert.equal(status.status, 'unavailable'); assert.equal(status.remaining, undefined)
    assert.ok(api.calls.length <= 5)
  }
})
test('unknown shapes, empty first page, invalid numbers and mixed units fail closed', async () => {
  for (const payload of [ {}, {data:{total:100}}, resources([]), resources([{remaining:0}]), resources([row(-1, 0)]), resources([row(2, 3)]), resources([row(Infinity, 0)]), resources([{total:null,remaining:0}]), resources([{total:'',remaining:'0'}]), resources([{...row(), unit:'credits'}, {...row(), unit:'tokens'}]), resources([{...row(), Unlimited:true}]), accounts([{Status:0, CapacitySize:10}]) ]) {
    const api = mock([payload])
    const status = await createAccountRefresher({fetch:api.fetch, readCredentials:async () => login})()
    assert.equal(status.status, 'unavailable'); assert.equal(status.remaining, undefined)
  }
})
test('missing, encrypted, alternate-host, enterprise, API-key and injected credentials never request', async () => {
  for (const credentials of [ undefined, {}, {accessToken:'other-format'}, {auth:{accessToken:{encrypted:'secret'}},account:login.account}, {...login,domain:'https://evil.example'}, {...login,account:{uid:'u',enterpriseId:'e'}}, {...login,auth:{accessToken:'secret',tokenType:'ApiKey'}}, {...login,auth:{accessToken:'secret\r\nX-Test:1'}}, {...login,account:{uid:'u\nsecret'}} ]) {
    const api = mock([resources([])])
    assert.equal((await createAccountRefresher({fetch:api.fetch,readCredentials:async () => credentials})()).status, 'unavailable')
    assert.equal(api.calls.length, 0)
  }
})
test('HTTP authentication failures are actionable without echoing remote text', async () => {
  for (const statusCode of [401,403]) {
    const api = mock([{message:login.auth.accessToken}], statusCode)
    const status = await createAccountRefresher({fetch:api.fetch, readCredentials:async () => login})()
    assert.equal(status.status,'auth-required')
    assert.ok(!JSON.stringify(status).includes(login.auth.accessToken))
    assert.equal(api.calls.length,1)
  }
})
test('body authentication errors and service failures do not become zero', async () => {
  for (const [code, expected] of [[401,'auth-required'],[403,'auth-required'],[500,'unavailable']] as const) {
    const api = mock([{code, message:login.auth.accessToken}])
    const status = await createAccountRefresher({fetch:api.fetch,readCredentials:async () => login})()
    assert.equal(status.status,expected); assert.equal(status.remaining,undefined)
    assert.ok(!JSON.stringify(status).includes(login.auth.accessToken))
  }
})
test('read errors, fetch errors, redirect failures and malformed JSON are sanitized', async () => {
  const failing: typeof fetch = async () => { throw new Error(login.auth.accessToken) }
  for (const fetcher of [failing, async () => new Response('secret-not-json'), async () => new Response(login.auth.accessToken,{status:302,headers:{Location:'https://evil.example'}})]) {
    const status = await createAccountRefresher({fetch:fetcher,readCredentials:async () => login})()
    assert.equal(status.status,'error'); assert.ok(!JSON.stringify(status).includes(login.auth.accessToken))
  }
  const api = mock([resources([])])
  const status = await createAccountRefresher({fetch:api.fetch,readCredentials:async () => {throw new Error('private/path/' + login.auth.accessToken)}})()
  assert.equal(status.status,'unavailable'); assert.equal(api.calls.length,0)
  assert.ok(!JSON.stringify(status).includes('private/path'))
})
test('partially overlapping pages fail closed even when object key order changes', async () => {
  const repeated = grant(99)
  const reordered = Object.fromEntries(Object.entries(repeated).reverse())
  const api = mock([accounts(fullPage()), accounts([reordered, grant(100)])])
  const status = await createAccountRefresher({fetch:api.fetch,readCredentials:async () => login})()
  assert.equal(status.status,'unavailable'); assert.equal(status.remaining,undefined)
})
test('inconsistent counts, premature tails, shape changes and missing quota fields fail closed', async () => {
  for (const pages of [
    [accounts([grant(1)], -1)],
    [accounts([grant(1)], 0)],
    [accounts([grant(1)], 2), accounts([] ,2)],
    [accounts([grant(1)], 2), accounts([grant(2)], 3)],
    [accounts(fullPage()), resources([row()])],
    [accounts([grant(1), {PackageCode:'unknown'}])],
  ]) {
    const api = mock(pages)
    const status = await createAccountRefresher({fetch:api.fetch,readCredentials:async () => login})()
    assert.equal(status.status,'unavailable'); assert.equal(status.remaining,undefined)
  }
})
test('oversized responses are cancelled and return sanitized errors', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) },
    cancel() { cancelled = true },
  })
  const status = await createAccountRefresher({fetch:async () => new Response(body),readCredentials:async () => login})()
  assert.equal(status.status,'error'); assert.equal(cancelled,true)
})
