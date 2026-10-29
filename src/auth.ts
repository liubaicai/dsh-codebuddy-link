import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { settingsPath } from './settings.ts'

const ORIGIN = 'https://www.codebuddy.cn'
const LIMIT = 64 * 1024
const TTL = 600_000
const INTERVAL = 2
const REQUEST_TIMEOUT = 15_000
const invalid = () => new Error('Unsupported CodeBuddy personal-account credentials')
const failed = () => new Error('CodeBuddy authorization failed or timed out')
const expired = () => new Error('CodeBuddy authorization flow is no longer active')
type ObjectValue = Record<string, unknown>
export interface Credential { accessToken: string; uid: string }
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined
}
function personal(value: ObjectValue): void {
  for (const key of ['enterpriseId', 'enterprise_id', 'enterpriseName', 'enterprise_name', 'tenantId', 'tenant_id']) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== '') throw invalid()
  }
  for (const key of ['domain', 'baseUrl', 'base_url']) {
    if (value[key] !== undefined && value[key] !== '' && value[key] !== 'www.codebuddy.cn' && value[key] !== ORIGIN) throw invalid()
  }
  if (value.tokenType !== undefined && value.tokenType !== 'Bearer') throw invalid()
}
function token(value: ObjectValue): string {
  if (value.accessToken !== undefined && value.access_token !== undefined && value.accessToken !== value.access_token) throw invalid()
  const result = value.accessToken ?? value.access_token
  if (typeof result !== 'string' || result.length > 16384 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(result) || /^(encrypted|protected|enc)[.:_-]/i.test(result)) throw invalid()
  return result
}
/** Strict JSON only: no bare tokens, no credential discovery and no refresh tokens retained. */
export function parseCredential(input: unknown): Credential {
  try {
    if (typeof input === 'string') {
      if (Buffer.byteLength(input) > LIMIT) throw invalid()
      input = JSON.parse(input) as unknown
    }
    const root = object(input)
    if (!root) throw invalid()
    personal(root)
    const nested = 'auth' in root || 'account' in root
    const auth = nested ? object(root.auth) : root
    const account = nested ? object(root.account) : root
    if (!auth || !account) throw invalid()
    if (nested && ('accessToken' in root || 'access_token' in root || 'uid' in root)) throw invalid()
    personal(auth); personal(account)
    const accessToken = token(auth), uid = account.uid
    if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(uid)) throw invalid()
    return { accessToken, uid }
  } catch { throw invalid() }
}

export class AuthStore {
  readonly path: string
  private generation = 0
  get revision(): number { return this.generation }
  constructor(path = join(dirname(settingsPath()), 'credentials.json')) { this.path = path }
  async read(): Promise<Credential | undefined> {
    let fd: number | undefined
    try {
      if (lstatSync(this.path).isSymbolicLink()) throw invalid()
      fd = openSync(this.path, 'r')
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > LIMIT) throw invalid()
      const bytes = Buffer.alloc(LIMIT + 1)
      const length = readSync(fd, bytes, 0, bytes.length, 0)
      if (length > LIMIT) throw invalid()
      return parseCredential(bytes.subarray(0, length).toString('utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('Cannot read CodeBuddy credentials')
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  async status(): Promise<{ configured: boolean }> {
    try { return { configured: (await this.read()) !== undefined } }
    catch { return { configured: false } }
  }
  async import(value: unknown): Promise<void> {
    const credential = parseCredential(value)
    this.generation++
    const tmp = this.path + '.' + randomBytes(16).toString('hex') + '.tmp'
    try {
      const parent = dirname(this.path)
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw invalid()
      chmodSync(parent, 0o700)
      // Synchronous atomic commit intentionally prevents cancel/clear interleaving with rename.
      writeFileSync(tmp, JSON.stringify(credential) + '\n', { flag: 'wx', mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.path)
    } catch { throw new Error('Cannot save CodeBuddy credentials') }
    finally { try { unlinkSync(tmp) } catch { /* no temporary secret left after successful rename */ } }
  }
  async clear(): Promise<void> {
    this.generation++
    try { unlinkSync(this.path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot clear CodeBuddy credentials') }
  }
}

/** Minimal persistence surface shared by legacy and managed-account OAuth. */
export interface AuthCredentialStore {
  readonly revision: number
  import(value: unknown): Promise<void>
  clear(): Promise<void>
}
export interface AuthManagerOptions { fetch?: typeof globalThis.fetch; now?: () => number }
export interface AuthStart { flowId: string; verificationUri: string; expiresIn: number; interval: number }
export type AuthPoll = { status: 'pending'; interval: number } | { status: 'ok' }
interface Flow {
  id: string; state: string; expires: number; revision: number; nextPoll: number
  controller: AbortController; running?: Promise<AuthPoll>; completed?: boolean
}
async function boundedJSON(response: Response): Promise<unknown> {
  if (!response.body) throw failed()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > LIMIT) throw failed()
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}
function success(payload: ObjectValue): boolean { return payload.code === 0 || payload.code === 200 }
function verification(value: unknown, state: string): string {
  if (value === undefined || value === '') return `${ORIGIN}/login?state=${encodeURIComponent(state)}`
  if (typeof value !== 'string' || value.length > 8192) throw failed()
  try {
    const url = new URL(value)
    if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password) throw failed()
    return url.href
  } catch { throw failed() }
}

export class AuthManager<Store extends AuthCredentialStore = AuthStore> {
  private readonly fetcher: typeof globalThis.fetch
  private readonly now: () => number
  private flow?: Flow
  private generation = 0
  private starting?: AbortController
  readonly store: Store
  constructor(store: Store, options: AuthManagerOptions = {}) {
    this.store = store; this.fetcher = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now
  }
  cancelAll(): void {
    this.generation++; this.starting?.abort(); this.starting = undefined
    this.flow?.controller.abort(); this.flow = undefined
  }
  cancel(flowId: string): void { if (this.flow?.id === flowId) this.cancelAll() }
  async clear(): Promise<void> { this.cancelAll(); await this.store.clear() }
  async import(value: unknown): Promise<void> { this.cancelAll(); await this.store.import(value) }
  private active(flow: Flow): void {
    if (this.flow !== flow || flow.controller.signal.aborted || this.now() >= flow.expires || this.store.revision !== flow.revision) throw expired()
  }
  private async request(path: string, controller: AbortController, init: RequestInit = {}): Promise<ObjectValue> {
    const timeout = new AbortController()
    const signal = AbortSignal.any([controller.signal, timeout.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(failed())
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT)
      })
      return await Promise.race([aborted, (async () => {
        const url = ORIGIN + '/v2/plugin' + path
        const response = await this.fetcher(url, { method: 'GET', ...init, redirect: 'error', signal })
        if (!response.ok || response.redirected || (response.url && response.url !== url)) throw failed()
        const payload = object(await boundedJSON(response))
        if (!payload) throw failed()
        return payload
      })()])
    } catch { throw failed() }
    finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort) }
  }
  async start(): Promise<AuthStart> {
    this.cancelAll()
    const generation = this.generation, revision = this.store.revision, started = this.now()
    const controller = new AbortController()
    this.starting = controller
    try {
      const payload = await this.request('/auth/state?platform=workbuddy', controller, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}',
      })
      const data = object(payload.data)
      if (!success(payload) || !data || typeof data.state !== 'string' || !data.state || data.state.length > 4096 || /[\x00-\x1f\x7f]/.test(data.state)) throw failed()
      const verificationUri = verification(data.authUrl ?? data.auth_url ?? data.url, data.state)
      const expires = started + TTL, remaining = expires - this.now()
      if (generation !== this.generation || revision !== this.store.revision || remaining <= 0) throw expired()
      const id = randomBytes(32).toString('hex')
      this.flow = { id, state: data.state, expires, revision, nextPoll: 0, controller }
      // This is remaining lifetime, not a constant 600: upstream latency consumes the TTL.
      // Round up fractional seconds so a still-active flow never advertises zero lifetime.
      return { flowId: id, verificationUri, expiresIn: Math.ceil(remaining / 1000), interval: INTERVAL }
    } finally { if (this.starting === controller) this.starting = undefined }
  }
  async poll(flowId: string): Promise<AuthPoll> {
    const flow = this.flow
    if (!flow || flow.id !== flowId) throw expired()
    this.active(flow)
    if (flow.completed) return { status: 'ok' }
    if (flow.running) return flow.running
    if (this.now() < flow.nextPoll) return { status: 'pending', interval: INTERVAL }
    flow.nextPoll = this.now() + INTERVAL * 1000
    flow.running = this.pollOnce(flow)
    try { return await flow.running }
    finally { flow.running = undefined }
  }
  private async pollOnce(flow: Flow): Promise<AuthPoll> {
    const payload = await this.request('/auth/token?state=' + encodeURIComponent(flow.state), flow.controller)
    this.active(flow)
    if (!success(payload)) return { status: 'pending', interval: INTERVAL }
    const auth = object(payload.data)
    if (!auth) throw failed()
    if (auth.accessToken === undefined && auth.access_token === undefined) return { status: 'pending', interval: INTERVAL }
    personal(auth)
    const accessToken = token(auth)
    const accounts = await this.request('/accounts', flow.controller, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } })
    this.active(flow)
    const data = object(accounts.data)
    if (!success(accounts) || !Array.isArray(data?.accounts) || !data.accounts.length) throw failed()
    const rows = data.accounts.map(object)
    const account = rows.find(row => row?.lastLogin === true) ?? rows[0]
    if (!account) throw failed()
    const credential = parseCredential({ auth, account })
    this.active(flow)
    const saved = this.store.import(credential)
    flow.revision = this.store.revision
    await saved
    this.active(flow)
    flow.completed = true
    return { status: 'ok' }
  }
}
