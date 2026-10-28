import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('discovery enriches context windows from models.dev with static fallback and bounded hangs', async () => {
  const catalog = { models: [{ id: 'hy3', name: 'Hunyuan' }, { id: 'mystery', name: 'Mystery' }], agents: [{ name: 'cli', models: ['hy3', 'mystery'] }] }
  const devRegistry = { tencent: { models: { 'tencent/hy3': { limit: { context: 300000 } } } } }
  const cn = async (url: unknown, dev: () => Promise<Response>): Promise<Response> =>
    String(url) === 'https://models.dev/api.json' ? dev()
    : String(url).endsWith('codebuddy.ai/v3/config') ? new Response(JSON.stringify({ code: 0, data: { models: null } }))
    : new Response(JSON.stringify({ code: 0, data: catalog }))
  const enriched = await createModelDiscoverer({ fetch: (url, init) => cn(url, async () => {
    assert.equal(init!.credentials, 'omit')
    return new Response(JSON.stringify(devRegistry))
  }) })()
  assert.equal(enriched.status, 'ok')
  assert.equal(enriched.models.find(m => m.id === 'hy3')?.contextWindow, 300000)
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
test('international directory merges without receiving China credentials', async () => {
  const internationalConfiguration = { models: [{ id: 'intl-model', name: 'International model' }], agents: [{ name: 'cli', models: ['intl-model'] }] }
  const calls: { url: string; init: RequestInit }[] = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! })
    if (String(url).endsWith('codebuddy.ai/v3/config')) return new Response(JSON.stringify({ code: 0, data: internationalConfiguration }))
    return new Response(JSON.stringify({ code: 0, data: { models: null } }))
  }
  const result = await createModelDiscoverer({ fetch, packageFallback: false, readCredentials: async () => ({ accessToken: 'cn-secret', uid: 'fixture-user' }) })()
  assert.equal(result.status, 'ok')
  assert.ok(result.models.some(model => model.id === 'intl-model'))
  const internationalCalls = calls.filter(call => call.url.endsWith('codebuddy.ai/v3/config'))
  assert.equal(internationalCalls.length, 1)
  for (const call of internationalCalls) assert.equal(new Headers(call.init.headers).get('authorization'), null)
  const cnCalls = calls.filter(call => call.url.endsWith('codebuddy.cn/v3/config'))
  assert.equal(new Headers(cnCalls[1]!.init.headers).get('authorization'), 'Bearer cn-secret')
  assert.ok(!JSON.stringify(result).includes('cn-secret'))
})
test('CN success still merges international catalog and package candidates with deduplication', async () => {
  const international = { code: 0, data: { models: [{ id: 'fixture-model', name: 'Stale international name' }, { id: 'intl-model', name: 'Intl-only' }], agents: [{ name: 'cli', models: ['fixture-model', 'intl-model'] }] } }
  const dir = await mkdtemp(join(tmpdir(), 'cb-merge-'))
  try {
    await mkdir(join(dir, 'bin'))
    await writeFile(join(dir, 'bin', 'codebuddy'), '#!/usr/bin/env node\n')
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@tencent-ai/codebuddy-code' }))
    await writeFile(join(dir, 'product.json'), JSON.stringify({ models: [{ id: 'pkg-model', name: 'Pkg-only' }, { id: 'fixture-model', name: 'Stale package name' }], agents: [{ name: 'cli', models: ['pkg-model', 'fixture-model'] }] }))
    const merged = await createModelDiscoverer({ bin: join(dir, 'bin', 'codebuddy'), fetch: mock([payload], 200, international).fetch })()
    assert.equal(merged.status, 'ok')
    assert.equal(merged.source, 'official-config')
    assert.deepEqual(merged.models, [
      { id: 'fixture-model', name: 'Fixture model' },
      { id: 'intl-model', name: 'Intl-only' },
      { id: 'pkg-model', name: 'Pkg-only' },
    ])
    assert.match(merged.message, /已获取中国区官方 CLI 目录。/)
    assert.match(merged.message, /已获取国际区公开 CLI 目录。/)
    assert.match(merged.message, /已合并安装包 CLI 模型候选。/)
    // Partial failure: international endpoint down must not hide the CN catalog.
    const cnOnly = await createModelDiscoverer({ bin: join(dir, 'bin', 'codebuddy'), fetch: async url => {
      if (String(url).endsWith('codebuddy.ai/v3/config')) throw new Error('international unreachable')
      return new Response(JSON.stringify(payload))
    } })()
    assert.equal(cnOnly.status, 'ok')
    assert.deepEqual(cnOnly.models, [{ id: 'fixture-model', name: 'Fixture model' }, { id: 'pkg-model', name: 'Pkg-only' }])
    assert.match(cnOnly.message, /国际区公开目录未能获取/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('package fallback discovers installed official data without executing CLI or reading user cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-models-'))
  try {
    await mkdir(join(dir, 'dist'))
    const bin = join(dir, 'dist', 'codebuddy.js')
    await writeFile(bin, 'throw new Error("must never execute CLI")')
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@tencent-ai/codebuddy-code' }))
    await writeFile(join(dir, 'product.json'), JSON.stringify(configuration))
    const discover = createModelDiscoverer({ bin, fetch: mock([{ code: 0, data: { models: null } }]).fetch })
    const result = await discover()
    assert.equal(result.status, 'ok')
    assert.equal(result.source, 'cli-package')
    assert.match(result.message, /未验证账户/)
    assert.deepEqual(result.models, [{ id: 'fixture-model', name: 'Fixture model' }])
    await writeFile(join(dir, 'product.json'), JSON.stringify({ ...configuration, models: [{ id: 'fixture-model', name: 'Updated' }] }))
    assert.equal((await discover()).models[0]?.name, 'Updated')
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'unrelated-package' }))
    assert.equal((await discover()).status, 'unavailable')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('current official bin/codebuddy wrapper is recognized without execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-wrapper-'))
  try {
    await mkdir(join(dir, 'bin'))
    const bin = join(dir, 'bin', 'codebuddy')
    await writeFile(bin, '#!/usr/bin/env node\nthrow Error("must never execute")')
    await chmod(bin, 0o755)
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@tencent-ai/codebuddy-code', bin: { codebuddy: './bin/codebuddy' } }))
    await writeFile(join(dir, 'product.json'), JSON.stringify(configuration))
    const result = await createModelDiscoverer({ bin, fetch: mock([{ code: 0, data: { models: null } }]).fetch })()
    assert.equal(result.source, 'cli-package')
    assert.deepEqual(result.models, [{ id: 'fixture-model', name: 'Fixture model' }])
    if (process.platform === 'win32') {
      const prefix = join(dir, 'npm'), root = join(prefix, 'node_modules', '@tencent-ai', 'codebuddy-code')
      await mkdir(join(root, 'bin'), { recursive: true })
      await writeFile(join(root, 'bin', 'codebuddy'), '#!/usr/bin/env node\nthrow Error("must never execute")')
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@tencent-ai/codebuddy-code' }))
      await writeFile(join(root, 'product.json'), JSON.stringify(configuration))
      const shim = join(prefix, 'codebuddy.cmd')
      await writeFile(shim, '@ECHO off\r\n"node" "%dp0%\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*')
      assert.equal((await createModelDiscoverer({ bin: shim, fetch: mock([{ code: 0, data: { models: null } }]).fetch })()).source, 'cli-package')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('desktop PATH without codebuddy discovers NVM and npm prefixes, respecting explicit bin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-desktop-'))
  const keys = ['PATH', 'NVM_SYMLINK', 'npm_config_prefix', 'NPM_CONFIG_PREFIX', 'APPDATA'] as const
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    const prefix = join(dir, 'node-install'), root = join(prefix, 'node_modules', '@tencent-ai', 'codebuddy-code')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@tencent-ai/codebuddy-code' }))
    await writeFile(join(root, 'product.json'), JSON.stringify(configuration))
    // No launcher exists at all, and Electron can live far away from this prefix.
    process.env.PATH = join(dir, 'desktop-path')
    process.env.APPDATA = join(dir, 'roaming')
    delete process.env.npm_config_prefix
    delete process.env.NPM_CONFIG_PREFIX
    process.env.NVM_SYMLINK = prefix
    const fetch = mock([{ code: 0, data: { models: null } }]).fetch
    const discover = createModelDiscoverer({ fetch })
    assert.equal((await discover()).source, 'cli-package')
    assert.deepEqual((await discover()).models, [{ id: 'fixture-model', name: 'Fixture model' }])
    assert.deepEqual((await createModelDiscoverer({ fetch, bin: join(dir, 'missing.js') })()).models, [])
    assert.deepEqual((await createModelDiscoverer({ fetch, packageFallback: false })()).models, [])
    process.env.NVM_SYMLINK = join(dir, 'missing-nvm')
    process.env.npm_config_prefix = prefix
    assert.equal((await discover()).source, 'cli-package')
    // An earlier non-official package must not shadow the valid npm installation.
    const fake = join(dir, 'fake', 'node_modules', '@tencent-ai', 'codebuddy-code')
    await mkdir(fake, { recursive: true })
    await writeFile(join(fake, 'package.json'), JSON.stringify({ name: 'not-codebuddy' }))
    await writeFile(join(fake, 'product.json'), JSON.stringify({ models: [{ id: 'fake' }], agents: [{ name: 'cli', models: ['fake'] }] }))
    process.env.NVM_SYMLINK = join(dir, 'fake')
    assert.deepEqual((await discover()).models, [{ id: 'fixture-model', name: 'Fixture model' }])
    const serialized = JSON.stringify(await discover())
    assert.ok(!serialized.includes(dir))
    assert.ok(!serialized.includes('do-not-return'))
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
    await rm(dir, { recursive: true, force: true })
  }
})
