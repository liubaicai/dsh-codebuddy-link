import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelDiscoverer, parseContextRegistry, parseModelConfiguration, STATIC_CONTEXT_WINDOWS } from '../src/models.ts'

const configuration = {
  models: [{ id: 'fixture-model', name: 'Fixture model', apiKey: 'do-not-return', url: 'https://invalid.example' }, { id: 'fixture-other', name: 'Other' }],
  agents: [{ name: 'cli', models: ['fixture-model'] }],
}
const payload = { code: 0, data: configuration }
function mock(values: unknown[], status = 200, international: unknown = { code: 0, data: { models: null } }) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://models.dev/api.json') return new Response('{}', { status: 404 })
    if (String(url) === 'https://www.codebuddy.ai/v3/config') return new Response(JSON.stringify(international), { status })
    calls.push({ url: String(url), init: init! })
    return new Response(JSON.stringify(values[Math.min(calls.length - 1, values.length - 1)]), { status })
  }
  return { fetch, calls }
}
test('version rejection does not trigger credential retry or echo upstream details', async () => {
  for (const status of [200,400]) {
    const api = mock([{code:12403,message:'PRIVATE rejected version'}],status)
    let credentialReads = 0
    const value = await createModelDiscoverer({fetch:api.fetch,packageFallback:false,readCredentials:async () => {credentialReads++;return undefined}})()
    assert.notEqual(value.status,'ok'); assert.deepEqual(value.models,[])
    assert.equal(api.calls.length,1); assert.equal(credentialReads,0)
    assert.equal(new Headers(api.calls[0]!.init.headers).get('user-agent'),'CLI/2.63.2 CodeBuddy/2.63.2')
    assert.doesNotMatch(JSON.stringify(value),/PRIVATE/)
  }
})

test('parseContextRegistry projects provider-qualified ids and keeps only safe integer windows', () => {
  const registry = parseContextRegistry({
    openai: { models: { 'openai/gpt-x': { limit: { context: 100000 } } } },
    tencent: { models: [
      { id: 'tencent/hy3', limit: { context: 262144 } },
      { id: 'other/HY3', limit: { context: 200000 } },
      { id: 'tencent/none', name: 'no limit field' },
      { id: 'tencent/negative', limit: { context: -5 } },
      { id: 'tencent/huge', limit: { context: 200_000_000 } },
      { id: 'tencent/fraction', limit: { context: 1.5 } },
    ] },
  })
  assert.equal(registry.get('gpt-x'), 100000)
  assert.equal(registry.get('hy3'), 262144)
  assert.equal(registry.size, 2)
  assert.equal(parseContextRegistry(null).size, 0)
  assert.equal(parseContextRegistry('nope').size, 0)
})

test('discovery uses static metadata immediately then reuses the background registry cache', async () => {
  const catalog = { models: [{ id: 'hy3', name: 'Hunyuan' }, { id: 'mystery', name: 'Mystery' }], agents: [{ name: 'cli', models: ['hy3', 'mystery'] }] }
  const devRegistry = { tencent: { models: { 'tencent/hy3': { limit: { context: 300000 } } } } }
  const cn = async (url: unknown, dev: () => Promise<Response>): Promise<Response> =>
    String(url) === 'https://models.dev/api.json' ? dev()
    : String(url).endsWith('codebuddy.ai/v3/config') ? new Response(JSON.stringify({ code: 0, data: { models: null } }))
    : new Response(JSON.stringify({ code: 0, data: catalog }))
  let release!: (response: Response) => void
  let registryCalls = 0
  const discover = createModelDiscoverer({ packageFallback: false, fetch: (url, init) => cn(url, () => {
    registryCalls++
    assert.equal(init!.credentials, 'omit')
    assert.equal(init!.headers, undefined)
    return new Promise<Response>(resolve => { release = resolve })
  }) })
  const enriched = await discover()
  assert.equal(enriched.status, 'ok')
  assert.equal(enriched.models.find(m => m.id === 'hy3')?.contextWindow, STATIC_CONTEXT_WINDOWS['hy3'])
  await discover()
  assert.equal(registryCalls, 1, 'concurrent refreshes share one registry request')
  release(new Response(JSON.stringify(devRegistry)))
  await new Promise(resolve => setImmediate(resolve))
  const cached = await discover()
  assert.equal(cached.models.find(m => m.id === 'hy3')?.contextWindow, 300000)
  assert.equal(registryCalls, 1, 'fresh cache avoids another registry request')
  assert.equal(enriched.models.find(m => m.id === 'hy3')?.contextWindow, STATIC_CONTEXT_WINDOWS['hy3'], 'background updates do not mutate returned results')
  assert.equal(enriched.models.find(m => m.id === 'mystery')?.contextWindow, undefined)
  const offline = await createModelDiscoverer({ fetch: (url) => cn(url, async () => { throw new Error('offline') }) })()
  assert.equal(offline.models.find(m => m.id === 'hy3')?.contextWindow, STATIC_CONTEXT_WINDOWS['hy3'])
  const hung = await createModelDiscoverer({ timeoutMs: 20, fetch: (url) => cn(url, () => new Promise(() => {}) as Promise<Response>) })()
  assert.equal(hung.models.find(m => m.id === 'hy3')?.contextWindow, STATIC_CONTEXT_WINDOWS['hy3'])
})

test('only authoritative CLI membership plus definitions is projected and deduplicated', () => {
  assert.deepEqual(parseModelConfiguration(configuration), [{ id: 'fixture-model', name: 'Fixture model' }])
  assert.deepEqual(parseModelConfiguration({ models: configuration.models }), [])
  assert.deepEqual(parseModelConfiguration({ ...configuration, agents: [{ name: 'cli', models: ['fixture-model', 'fixture-model', 'missing', '--bad', 'bad\n'] }] }), [{ id: 'fixture-model', name: 'Fixture model' }])
  assert.deepEqual(parseModelConfiguration({ ...configuration, models: [{ id: 'fixture-model', hidden: true }] }), [])
  assert.deepEqual(parseModelConfiguration({ ...configuration, models: Array(1001).fill(configuration.models[0]) }), [])
})
test('discovery shares request ID boundaries and never admits provider paths or trailing controls', () => {
  const accepted = [128, 129, 256].map(length => 'm'.repeat(length))
  const rejected = ['m'.repeat(257), 'provider/model', 'https://host/model', '/tmp/model', '../model', 'C:\\model', 'C:model', 'bad\n', 'bad\r', 'bad\t', 'bad\0']
  const ids = [...accepted, ...rejected]
  const definitions = ids.map(id => ({ id, name: 'Fixture' }))
  const catalog = (models: unknown[], members: string[]) => ({ models, agents: [{ name: 'cli', models: members }] })
  assert.deepEqual(parseModelConfiguration(catalog(definitions, ids)).map(model => model.id), accepted)
  // Validate both the definitions and the membership, not just their intersection.
  for (const id of rejected) assert.deepEqual(parseModelConfiguration(catalog([{ id }], [id])), [])
})

test('context registry validates bounded returned IDs before projecting bare names', () => {
  const accepted = [128, 129, 256].map(length => 'm'.repeat(length))
  const qualified = [128, 129, 256].map(length => `vendor/${'q'.repeat(length - 7)}`)
  const rejected = ['m'.repeat(257), `vendor/${'q'.repeat(250)}`, 'https://host/model', '/tmp/model', '../model', 'a/b/model', 'C:/model', 'C:model', 'vendor/model\n']
  const registry = parseContextRegistry({ fixture: { models: [...accepted, ...qualified, ...rejected].map(id => ({ id, limit: { context: 123456 } })) } })
  assert.deepEqual([...registry.keys()], [...accepted, ...qualified.map(id => id.split('/')[1])])
})

test('anonymous official configuration works without touching injected credentials', async () => {
  const api = mock([payload])
  const result = await createModelDiscoverer({ fetch: api.fetch, readCredentials: async () => { throw Error('must not read') }, now: () => new Date('2026-01-01T00:00:00Z') })()
  assert.equal(result.status, 'ok')
  assert.equal(result.source, 'official-config')
  assert.equal(result.updatedAt, '2026-01-01T00:00:00.000Z')
  assert.ok(result.models.some(model => model.id === 'fixture-model' && model.name === 'Fixture model'))
  assert.equal(api.calls.length, 1)
  const call = api.calls[0]!
  assert.equal(call.url, 'https://www.codebuddy.cn/v3/config')
  assert.equal(call.init.redirect, 'error')
  assert.equal(call.init.credentials, 'omit')
  assert.equal(call.init.method, 'GET')
  assert.equal(new Headers(call.init.headers).get('authorization'), null)
  assert.ok(!JSON.stringify(result).includes('do-not-return'))
})
test('empty anonymous config retries only with explicit validated server-side credentials', async () => {
  const api = mock([{ code: 0, data: { models: null } }, payload])
  const discover = createModelDiscoverer({ fetch: api.fetch, readCredentials: async () => ({ accessToken: 'fictional-secret', uid: 'fixture-user' }), packageFallback: false })
  const result = await discover()
  assert.equal(result.status, 'ok')
  assert.equal(api.calls.length, 2)
  assert.equal(new Headers(api.calls[1]!.init.headers).get('authorization'), 'Bearer fictional-secret')
  assert.equal(new Headers(api.calls[1]!.init.headers).get('x-user-id'), 'fixture-user')
  assert.equal(new Headers(api.calls[1]!.init.headers).get('user-agent'), 'CLI/2.63.2 CodeBuddy/2.63.2')
  assert.ok(!JSON.stringify(result).includes('fictional-secret'))
})
test('unsupported credentials and exceptions never echo secrets', async () => {
  const api = mock([{ code: 0, data: { models: null } }])
  const result = await createModelDiscoverer({ fetch: api.fetch, packageFallback: false, readCredentials: async () => ({ accessToken: 'fictional-secret', uid: 'fixture-user', enterpriseId: 'not-supported' }) })()
  assert.equal(result.status, 'error')
  assert.equal(api.calls.length, 1)
  assert.ok(!JSON.stringify(result).includes('fictional-secret'))
  const thrown = await createModelDiscoverer({ fetch: async () => { throw Error('fictional-secret') }, packageFallback: false })()
  assert.ok(!JSON.stringify(thrown).includes('fictional-secret'))
})
test('unknown, empty, rejected, oversized and redirected responses do not invent models', async () => {
  for (const value of [{ code: 0, data: { models: null } }, { code: 0, data: configuration.models }, { code: 7, data: configuration }, { data: configuration }]) {
    const result = await createModelDiscoverer({ fetch: mock([value]).fetch, packageFallback: false })()
    assert.equal(result.status, 'unavailable')
    assert.deepEqual(result.models, [])
  }
  const auth = await createModelDiscoverer({ fetch: mock([{}], 401).fetch, packageFallback: false })()
  assert.equal(auth.status, 'auth-required')
  const large = await createModelDiscoverer({ fetch: async () => new Response(' '.repeat(4 * 1024 * 1024 + 1)), packageFallback: false })()
  assert.equal(large.status, 'error')
  const redirected = new Response(JSON.stringify(payload))
  Object.defineProperty(redirected, 'url', { value: 'https://untrusted.example/v3/config' })
  const result = await createModelDiscoverer({ fetch: async () => redirected, packageFallback: false })()
  assert.equal(result.status, 'error')
})
test('authentication is retried once and fresh credentials are read on each refresh', async () => {
  let reads = 0
  const calls: RequestInit[] = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://models.dev/api.json') return new Response('{}', { status: 404 })
    if (String(url).endsWith('codebuddy.ai/v3/config')) return new Response(JSON.stringify({ code: 0, data: { models: null } }))
    calls.push(init!)
    return new Response(JSON.stringify(calls.length % 2 ? { code: 401 } : payload))
  }
  const discover = createModelDiscoverer({ fetch, packageFallback: false, readCredentials: async () => ({ accessToken: `fixture-token-${++reads}`, uid: 'fixture-user' }) })
  assert.equal((await discover()).status, 'ok')
  assert.equal((await discover()).status, 'ok')
  assert.equal(reads, 2)
  assert.equal(new Headers(calls[1]!.headers).get('authorization'), 'Bearer fixture-token-1')
  assert.equal(new Headers(calls[3]!.headers).get('authorization'), 'Bearer fixture-token-2')
})
test('timeout bounds fetchers ignoring cancellation', async () => {
  const result = await createModelDiscoverer({ fetch: () => new Promise(() => {}), timeoutMs: 10, packageFallback: false })()
  assert.equal(result.status, 'error')
  assert.deepEqual(result.models, [])
  assert.throws(() => createModelDiscoverer({ timeoutMs: Infinity }), RangeError)
})
test('catalogs stay within the selected channel without package fallback', async () => {
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = async url => {
    calls.push(String(url))
    if (String(url) === 'https://models.dev/api.json') return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(String(url).includes('codebuddy.ai')
      ? { code: 0, data: { models: [{ id: 'gpt-fixture' }], agents: [{ name: 'cli', models: ['gpt-fixture'] }] } }
      : payload))
  }
  const cn = await createModelDiscoverer({ fetch })()
  assert.deepEqual(cn.models, [{ id: 'fixture-model', name: 'Fixture model' }])
  assert.ok(!calls.some(url => url.includes('codebuddy.ai')))
  calls.length = 0
  const international = await createModelDiscoverer({ fetch, region: 'international', readCredentials: async () => { throw Error('must not read CN credentials') } })()
  assert.deepEqual(international.models, [{ id: 'gpt-fixture', name: 'gpt-fixture' }])
  assert.ok(!calls.some(url => url.includes('codebuddy.cn')))
  const empty = await createModelDiscoverer({ fetch: mock([{ code: 0, data: { models: null } }]).fetch })()
  assert.deepEqual(empty.models, [])
  assert.equal(empty.status, 'unavailable')
})
