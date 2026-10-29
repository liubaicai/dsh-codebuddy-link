import { open, realpath } from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { parseCredential } from './auth.ts'
import { CODEBUDDY_COMPAT_USER_AGENT } from './compatibility.ts'
import { resolveCodeBuddyBin } from './runner.ts'
import { isRequestModelIdentifier, isReturnedModelIdentifier } from './model-id.ts'

const CN_ENDPOINT = 'https://www.codebuddy.cn/v3/config'
const INTERNATIONAL_ENDPOINT = 'https://www.codebuddy.ai/v3/config'
const MODELS_DEV_ENDPOINT = 'https://models.dev/api.json'
const LIMIT = 4 * 1024 * 1024
const MODELS_DEV_LIMIT = 32 * 1024 * 1024
const MAX_MODELS = 1000
type ObjectValue = Record<string, unknown>
export interface DiscoveredModel { id: string; name: string; contextWindow?: number }
/**
 * Offline snapshot of models.dev limit.context values for official CLI model ids
 * (checked 2026-10-28). Used when models.dev cannot be reached so the context
 * window advertised to DSH stays honest without network access.
 */
export const STATIC_CONTEXT_WINDOWS: Record<string, number> = {
  'hy3': 262144, 'hy4-preview': 1048576,
  'deepseek-v4.1-flash': 1050000,
  'gpt-6-astra': 1050000, 'gpt-5.6-sol': 1050000, 'gpt-5.6-terra': 1050000, 'gpt-5.6-luna': 1050000,
  'gpt-5.5': 1050000, 'gpt-5.4': 1050000, 'gemini-3.5-flash': 1048576,
  'glm-5.3-flash': 1049000, 'glm-5.3': 1049000, 'glm-5.2': 1049000,
  'kimi-k3': 1113088, 'kimi-k2.6': 262144,
}

/** Projects models.dev entries to last-segment id → largest advertised context window. */
export function parseContextRegistry(value: unknown): Map<string, number> {
  const registry = new Map<string, number>()
  const config = object(value)
  if (!config) return registry
  const record = (model: ObjectValue | undefined) => {
    const limit = object(model?.limit)
    const context = Number(limit?.context)
    if (!model || !isReturnedModelIdentifier(model.id) || !Number.isSafeInteger(context) || context <= 0 || context > 100_000_000) return
    // models.dev ids are provider-qualified ("tencent/hy3"); CodeBuddy uses the bare id.
    const id = model.id.split('/').pop()!.toLowerCase()
    registry.set(id, Math.max(registry.get(id) ?? 0, context))
  }
  for (const provider of Object.values(config)) {
    const models = object(provider)?.models
    if (Array.isArray(models)) { for (const model of models) record(object(model)); continue }
    // Object form: the map key is the id ("openai/gpt-x": {...}).
    if (models && typeof models === 'object') for (const [key, model] of Object.entries(models)) record({ ...(object(model) ?? {}), id: object(model)?.id ?? key })
  }
  return registry
}
export interface ModelDiscoveryResult {
  status: 'ok' | 'unavailable' | 'auth-required' | 'error'
  models: DiscoveredModel[]
  source: 'official-config' | 'cli-package'
  message: string
  updatedAt?: string
}
export interface ModelDiscovererOptions {
  bin?: string
  fetch?: typeof globalThis.fetch
  /** Explicit server-side AuthStore.read injection only. Never scans credential caches. */
  readCredentials?: () => Promise<unknown>
  now?: () => Date
  /** Set false to exclude installed package candidates; candidates are not entitlement checks. */
  packageFallback?: boolean
  timeoutMs?: number
}
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined
}

/** Projects only known CLI model ids/names; never returns URLs, API keys or arbitrary metadata. */
export function parseModelConfiguration(value: unknown): DiscoveredModel[] {
  const config = object(value)
  if (!config || !Array.isArray(config.models) || config.models.length > MAX_MODELS || !Array.isArray(config.agents) || config.agents.length > MAX_MODELS) return []
  const cli = config.agents.map(object).find(agent => agent?.name === 'cli')
  if (!Array.isArray(cli?.models) || cli.models.length > MAX_MODELS) return []
  const definitions = new Map<string, ObjectValue>()
  for (const value of config.models) {
    const model = object(value)
    if (model && isRequestModelIdentifier(model.id) && !definitions.has(model.id)) definitions.set(model.id, model)
  }
  const seen = new Set<string>(), result: DiscoveredModel[] = []
  for (const id of cli.models) {
    if (!isRequestModelIdentifier(id) || seen.has(id)) continue
    seen.add(id)
    const model = definitions.get(id)
    if (!model || model.hidden === true || model.disabled === true) continue
    const name = typeof model.name === 'string' && model.name.trim() && model.name.length <= 256 && !/[\x00-\x1f\x7f]/.test(model.name) ? model.name : id
    result.push({ id, name })
  }
  return result
}
async function fileJSON(path: string): Promise<unknown> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > LIMIT) throw new Error('Invalid package configuration')
    const bytes = Buffer.alloc(LIMIT + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > LIMIT) throw new Error('Package configuration too large')
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as unknown
  } finally { await file.close() }
}
function packageRoot(entry: string): string | undefined {
  // Official releases use both the older dist entry and the current bin wrapper.
  const folder = basename(dirname(entry)), name = basename(entry)
  return (folder === 'dist' && name === 'codebuddy.js') || (folder === 'bin' && name === 'codebuddy') ? dirname(dirname(entry)) : undefined
}
async function readPackageModels(candidate: string): Promise<DiscoveredModel[]> {
  const root = await realpath(candidate)
  const manifestPath = join(root, 'package.json'), productPath = join(root, 'product.json')
  // Do not follow a product/manifest symlink into user configuration or secret files.
  if (await realpath(manifestPath) !== manifestPath || await realpath(productPath) !== productPath) return []
  const manifest = object(await fileJSON(manifestPath))
  if (manifest?.name !== '@tencent-ai/codebuddy-code') return []
  return parseModelConfiguration(await fileJSON(productPath))
}
async function packageModels(bin?: string): Promise<DiscoveredModel[]> {
  // Never execute npm/CLI/shells or inspect ~/.codebuddy, .npmrc, login files,
  // product overrides or cache directories. An explicit bin pins one installation.
  try {
    const executable = await resolveCodeBuddyBin(bin || 'codebuddy')
    const entry = executable.args[0] ?? executable.command
    const root = packageRoot(await realpath(entry))
    if (root) {
      const models = await readPackageModels(root)
      if (models.length) return models
    }
  } catch { /* A desktop process can inherit a PATH without npm launchers. */ }
  if (bin && bin !== 'codebuddy') return []

  // Bounded standard installation prefixes, not user-specific paths or a disk scan.
  // NVM_SYMLINK is essential on Windows: Electron's execPath is not the Node binary.
  const prefixes = [process.env.NVM_SYMLINK, process.env.npm_config_prefix, process.env.NPM_CONFIG_PREFIX,
    process.platform === 'win32' && process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined,
    dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).slice(0, 128)]
  const roots = new Set<string>()
  for (const value of prefixes) {
    const prefix = value?.replace(/^"|"$/g, '')
    if (!prefix || !isAbsolute(prefix)) continue
    roots.add(join(prefix, 'node_modules', '@tencent-ai', 'codebuddy-code'))
    if (process.platform !== 'win32') {
      roots.add(join(prefix, 'lib', 'node_modules', '@tencent-ai', 'codebuddy-code'))
      if (basename(prefix) === 'bin') roots.add(join(dirname(prefix), 'lib', 'node_modules', '@tencent-ai', 'codebuddy-code'))
    }
  }
  for (const root of roots) {
    try {
      const models = await readPackageModels(root)
      if (models.length) return models
    } catch { /* A missing/malformed candidate must not hide later valid installs. */ }
  }
  return []
}
async function responseJSON(response: Response, limit = LIMIT): Promise<unknown> {
  if (!response.body) throw new Error('Missing response')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) throw new Error('Response too large')
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

/**
 * Fills contextWindow on discovered models from models.dev (public registry,
 * no auth, no credentials sent). Falls back to the bundled static snapshot.
 * Enrichment failures never fail discovery: the window is metadata, not access.
 */
async function enrichContextWindows(models: DiscoveredModel[], fetcher: typeof globalThis.fetch, timeoutMs: number): Promise<void> {
  let registry: Map<string, number> | undefined
  try {
    const request = (async () => {
      const response = await fetcher(MODELS_DEV_ENDPOINT, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) return
      registry = parseContextRegistry(await responseJSON(response, MODELS_DEV_LIMIT))
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    // The fetcher may ignore the abort signal; race so discovery never stalls.
    await Promise.race([request, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })])
    if (timer) clearTimeout(timer)
  } catch { /* offline or blocked: static snapshot below still applies */ }
  for (const model of models) {
    const context = registry?.get(model.id.toLowerCase()) ?? STATIC_CONTEXT_WINDOWS[model.id]
    if (Number.isSafeInteger(context) && context! > 0) model.contextWindow = context
  }
}

/**
 * Protocol evidence: official CLI 2.177.1 dist/codebuddy.js CloudProductProvider
 * uses /v3/config; CloudProductManager reads response.data.data.models and agents.
 * ProductEndpointHttpInterceptor sends X-Product: SaaS. Installed product.json
 * sets endpoint=https://www.codebuddy.ai and separates authentication internalDomain
 * (www.codebuddy.cn) from externalDomain (www.codebuddy.ai). Both use /v3/config.
 * It defines models plus agents[name=cli].models. No bundled ids are copied here.
 * Anonymous requests can return code=0/models=null: that is NOT a model list.
 */
export function createModelDiscoverer(options: ModelDiscovererOptions = {}): () => Promise<ModelDiscoveryResult> {
  const fetcher = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new RangeError('Invalid model discovery timeout')
  const result = (status: ModelDiscoveryResult['status'], message: string): ModelDiscoveryResult => ({ status, models: [], source: 'official-config', message })
  const remote = async (endpoint: string): Promise<ModelDiscoveryResult> => {
    let outcome = result('unavailable', '官方配置未返回可识别的 CLI 模型列表。')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const request = async (): Promise<ModelDiscoveryResult> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        // Real server evidence: once Authorization is present, /v3/config enforces a
        // parseable CLI version in User-Agent (otherwise HTTP 400 code 12403
        // "check ua, get coding copilot version error"). Match the official CLI UA
        // that credits.ts already proved against authenticated CN endpoints.
        const headers: Record<string, string> = { Accept: 'application/json', 'X-Product': 'SaaS', 'X-IDE-Type': 'CLI', 'User-Agent': CODEBUDDY_COMPAT_USER_AGENT }
        if (attempt) {
          // The injected credential belongs to the CN login flow. Never reuse it
          // on the international host, even when that host explicitly asks for auth.
          if (endpoint !== CN_ENDPOINT || !options.readCredentials) return outcome
          const raw = await options.readCredentials()
          if (raw == null) return outcome
          const login = parseCredential(raw)
          headers.Authorization = `Bearer ${login.accessToken}`
          headers['X-User-Id'] = login.uid
        }
        if (controller.signal.aborted) throw new Error('Timed out')
        const response = await fetcher(endpoint, { method: 'GET', headers, redirect: 'error', credentials: 'omit', signal: controller.signal })
        if (response.redirected || (response.url && response.url !== endpoint)) return result('error', '拒绝模型配置重定向。')
        if (response.status === 401 || response.status === 403) { outcome = result('auth-required', '官方模型配置需要有效授权。'); continue }
        if (!response.ok) return result('error', '官方模型配置请求失败。')
        const payload = object(await responseJSON(response))
        if (payload?.code === 401 || payload?.code === 403) { outcome = result('auth-required', '官方模型配置需要有效授权。'); continue }
        if (!payload || (payload.code !== 0 && payload.code !== 200)) return result('unavailable', '官方模型配置响应格式未知。')
        const models = parseModelConfiguration(payload.data)
        if (models.length) return { status: 'ok', models, source: 'official-config', updatedAt: (options.now ?? (() => new Date()))().toISOString(), message: '已从官方配置获取 CLI 模型；实际调用仍受账户权限与余额限制。' }
      }
      return outcome
    }
    try {
      // Race also bounds injected fetchers/readers that ignore AbortSignal.
      outcome = await Promise.race([request(), new Promise<ModelDiscoveryResult>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(result('error', '模型发现超时。')) }, timeoutMs)
      })])
    } catch { outcome = result('error', '模型发现失败；请检查网络或显式授权。') }
    finally { clearTimeout(timer); controller.abort() }
    return outcome
  }
  return async () => {
    // Independent deadlines retain a successful region even if another hangs.
    // Query the package even when CN succeeds: it can contain international ids.
    const [cn, international, packaged] = await Promise.all([
      remote(CN_ENDPOINT), remote(INTERNATIONAL_ENDPOINT),
      options.packageFallback === false ? Promise.resolve([] as DiscoveredModel[]) : packageModels(options.bin).catch(() => [] as DiscoveredModel[]),
    ])
    const models = new Map<string, DiscoveredModel>()
    // Prefer live names, then package names, with deterministic regional ordering.
    for (const model of [...cn.models, ...international.models, ...packaged]) {
      if (!models.has(model.id)) models.set(model.id, model)
    }
    const notes = [
      cn.status === 'ok' ? '已获取中国区官方 CLI 目录。' : `中国区：${cn.message}`,
      international.status === 'ok' ? '已获取国际区公开 CLI 目录。' : '国际区公开目录未能获取，可能需要国际区独立授权；当前候选不代表完整国际目录，未向国际域名发送中国区凭据。',
      packaged.length ? '已合并安装包 CLI 模型候选。' : '',
      '模型候选未验证账户可用权限；实际调用仍受地区、账户权限与余额限制。',
    ].filter(Boolean).join(' ')
    if (models.size) {
      const discovered = [...models.values()]
      await enrichContextWindows(discovered, fetcher, timeoutMs)
      return {
        status: 'ok', models: discovered,
        source: cn.models.length || international.models.length ? 'official-config' : 'cli-package',
        updatedAt: (options.now ?? (() => new Date()))().toISOString(), message: notes,
      }
    }
    const status = [cn.status, international.status].includes('error') ? 'error'
      : [cn.status, international.status].includes('auth-required') ? 'auth-required' : 'unavailable'
    return result(status, notes)
  }
}
