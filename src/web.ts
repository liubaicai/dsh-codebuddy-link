import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SettingsStore } from './settings.ts'
import { isModelIdentifier } from './metadata.ts'
import { isRequestModelIdentifier } from './model-id.ts'
import { isCodeBuddyEffort } from './config.ts'
import type { AccountService } from './account-service.ts'

export interface AccountStatus {
  status: 'ok' | 'unavailable' | 'auth-required' | 'error'
  message?: string
  remaining?: number
  total?: number
  used?: number
  unit?: string
  updatedAt?: string
  source?: string
}
export interface WebServerLike {
  register(route: {kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void}): unknown
}
export interface AuthService {
  status(): Promise<{configured:boolean}>
  start(accountId?: string): Promise<unknown>
  poll(flowId: string): Promise<unknown>
  cancel(flowId: string): unknown
  cancelAll(): void
}
export function registerSettingsRoutes(server: WebServerLike, store: SettingsStore, notify: () => void,
  refreshAccount: () => Promise<AccountStatus> = async () => ({status:'unavailable', message:'账户积分接口尚不可用；请在 CodeBuddy / WorkBuddy 客户端查看。'}), auth?: AuthService, refreshModels?: () => Promise<{models:{id:string;name:string;contextWindow?:number}[];message?:string}>,
  readRuns: () => unknown[] = () => [], accounts?: AccountService): () => void {
  let account: AccountStatus = {status:'unavailable',message:'点击刷新查询账户积分。'}
  let pending: Promise<void> | undefined
  let generation = 0
  let catalog: {id:string;name:string;contextWindow?:number}[] = []
  let modelPending: Promise<void> | undefined
  let modelMessage = ''
  const resetAccount = () => { generation++; pending = undefined; modelPending = undefined; catalog = []; modelMessage = ''; accounts?.changed(); notify(); account = {status:'unavailable',message:'账户已更新，请刷新积分。'} }
  const snapshot = async () => ({
    ...(store.loadError ? {settingsError:store.loadError} : {}),
    modelMessage,
    ...(accounts ? {accountPool: accounts.snapshot()} : {}),
    auth: auth ? await auth.status() : {configured:false},
    config: {enabled:store.config.enabled, permissionMode:store.config.permissionMode, models:store.config.models,
      hiddenModels:store.config.hiddenModels, defaultModel:store.config.defaultModel, tools:store.config.tools,
      reasoningEffort:store.config.reasoningEffort, maxConcurrency:store.config.maxConcurrency,
      queueTimeoutMs:store.config.queueTimeoutMs, stallWarnMs:store.config.stallWarnMs,
      dangerouslySkipPermissions:store.config.dangerouslySkipPermissions},
    runs: publicRuns(readRuns()),
    account, catalogModels:[...new Map([...catalog, ...store.config.models.filter(id => !catalog.some(m => m.id === id)).map(id => ({id,name:id === 'default' ? 'CodeBuddy CLI 默认模型' : id}))].map(m => [m.id,m])).values()],
  })
  const disposers: (() => void)[] = []
  for (const action of ['status','config','refresh', ...(refreshModels ? ['models'] : []), ...(auth ? ['auth/start','auth/poll','auth/cancel'] : []), ...(accounts ? ['account/update','account/remove','account/select','account/refresh'] : [])]) {
    const dispose = server.register({kind:'exact',path:`/plugins/codebuddy-link/${action}`,handler:(req,res) => {
      void (async () => {
        const send = (code: number, body: unknown) => { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(body)) }
        const method = action === 'status' ? 'GET' : 'POST'
        if (req.method !== method) { send(405,{error:`${method} only`}); return }
        // Host supplies authentication. Also reject cross-origin browser requests, even on loopback.
        const origin = req.headers.origin
        if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && !sameHost(origin, req.headers.host))) { send(403,{error:'Cross-origin request denied'}); return }
        try {
          if (action !== 'status') {
            if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { send(415,{error:'JSON required'}); return }
            const body = await readJson(req)
            if (action.startsWith('auth/') && auth) {
              if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body')
              const input = body as Record<string,unknown>
              if (action === 'auth/start') {
                if (Object.keys(input).some(key => key !== 'accountId') || (input.accountId !== undefined && typeof input.accountId !== 'string')) throw new Error('Invalid account')
                send(200,await auth.start(input.accountId as string | undefined))
              }
              else {
                if (typeof input.flowId !== 'string' || input.flowId.length > 128) throw new Error('Invalid flow')
                if (action === 'auth/cancel') { await auth.cancel(input.flowId); send(200,{status:'cancelled'}) }
                else {
                  const result = await auth.poll(input.flowId)
                  if (result && typeof result === 'object' && 'status' in result && result.status === 'ok') resetAccount()
                  send(200,result)
                }
              }
              return
            }
            if (action.startsWith('account/') && accounts) {
              if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid account action')
              const input = body as Record<string, unknown>
              const allowed = action === 'account/select' ? ['mode','accountId'] : action === 'account/update' ? ['id','name','enabled'] : ['id']
              if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Invalid account action')
              if (action === 'account/select') {
                if ((input.mode !== 'fixed' && input.mode !== 'pool') || (input.accountId !== undefined && typeof input.accountId !== 'string')) throw new Error('Invalid account selection')
                await accounts.configure({mode:input.mode, ...(input.accountId === undefined ? {} : {accountId:input.accountId as string})})
              } else {
                if (typeof input.id !== 'string' || input.id.length > 128) throw new Error('Invalid account')
                if (action === 'account/update') {
                  if ((input.name !== undefined && typeof input.name !== 'string') || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw new Error('Invalid account update')
                  await accounts.update(input.id, { ...(input.name === undefined ? {} : {name:input.name as string}), ...(input.enabled === undefined ? {} : {enabled:input.enabled as boolean}) })
                } else if (action === 'account/remove') await accounts.remove(input.id)
                else await accounts.refresh(input.id)
              }
              notify()
              send(200,await snapshot()); return
            }
            if (action === 'config') { store.updateFromPanel(body); notify() }
            else if (action === 'models' && refreshModels) {
              const version = generation
              modelPending ??= refreshModels().then(value => {
                if (version !== generation) return
                catalog = value.models; modelMessage = value.message ?? ''
                // Persist discovered context windows as plain metadata so the adapter
                // can advertise honest per-model limits; never fails the discovery.
                const windows: Record<string, number> = {}
                for (const model of value.models) if (Number.isSafeInteger(model.contextWindow) && model.contextWindow! > 0) windows[model.id] = model.contextWindow!
                if (Object.keys(windows).length) { try { store.update({modelContext: {...store.config.modelContext, ...windows}}) } catch { /* metadata only */ } }
              }).catch(() => { throw new Error('模型列表获取失败，请检查网络后重试。') }).finally(() => { if (version === generation) modelPending = undefined })
              await modelPending
            } else {
              const version = generation
              pending ??= Promise.resolve().then(refreshAccount).then(value => { if (generation === version) account = value }).catch(() => { if (generation === version) account = {status:'error',message:'账户积分查询失败，请检查登录和网络。'} }).finally(() => {if (generation === version) pending = undefined})
              await pending
            }
          }
          send(200,await snapshot())
        } catch (error) {
          // Snapshot/auth providers and filesystem errors may contain secrets or paths.
          // Only this fixed store diagnostic is safe to relay; never echo arbitrary errors.
          const accountStoreError = 'Cannot read CodeBuddy accounts; repair the account store before continuing'
          send(400,{error: error instanceof Error && error.message === accountStoreError ? accountStoreError
            : action.startsWith('auth/') || action.startsWith('account/') ? '账户操作失败，请检查账户选择与授权状态。'
            : action === 'config' ? '设置保存失败，请检查设置或管理员配置。'
            : action === 'models' ? '模型列表获取失败，请检查网络后重试。' : '状态读取失败，请检查配置与授权状态。'})
        }
      })()
    }})
    if (typeof dispose === 'function') disposers.push(dispose as () => void)
  }
  return () => { generation++; auth?.cancelAll(); for (const dispose of disposers.reverse()) dispose() }
}
// A runtime snapshot is deliberately a metadata-only boundary, never a raw runner object.
function publicRuns(values: unknown[]): Record<string, unknown>[] {
  if (!Array.isArray(values)) return []
  const recent: Record<string, unknown>[] = []
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const run = value as Record<string, unknown>
    if (typeof run.id !== 'string' || !['model', 'ask'].includes(String(run.source))
      || !['queued', 'starting', 'waiting', 'responding', 'completed', 'failed', 'cancelled'].includes(String(run.state))
      || typeof run.requestedModel !== 'string' || typeof run.requestedEffort !== 'string'
      || typeof run.queuedAt !== 'number' || !Number.isFinite(run.queuedAt)) continue
    const clean: Record<string, unknown> = {id:run.id, source:run.source, state:run.state,
      requestedModel:isRequestModelIdentifier(run.requestedModel) ? run.requestedModel : 'unknown', requestedEffort:isCodeBuddyEffort(run.requestedEffort) ? run.requestedEffort : 'auto', queuedAt:run.queuedAt,
      contextOverrideSent:false, reasoningConfirmed:false, warning:run.warning === true,
      queuePosition:Number.isSafeInteger(run.queuePosition) && Number(run.queuePosition) >= 0 ? run.queuePosition : 0}
    if (typeof run.accountId === 'string' && /^[a-f0-9]{32}$/.test(run.accountId)) clean.accountId = run.accountId
    if (typeof run.accountName === 'string' && run.accountName.length <= 100 && !/[\x00-\x1f\x7f]/.test(run.accountName)) clean.accountName = run.accountName
    if (isModelIdentifier(run.returnedModel)) clean.returnedModel = run.returnedModel
    if (run.contextSource === 'model' || run.contextSource === 'fallback') clean.contextSource = run.contextSource
    for (const key of ['contextWindow', 'startedAt', 'lastProgressAt', 'endedAt', 'totalCredits', 'totalCostUsd']) {
      if (typeof run[key] === 'number' && Number.isFinite(run[key]) && run[key] >= 0) clean[key] = run[key]
    }
    if (['timeout', 'queue-timeout', 'aborted', 'error'].includes(String(run.failure))) clean.failure = run.failure
    // Keep a bounded top five without sorting on every candidate. Insert after
    // equal timestamps to preserve the original stable ordering.
    const position = recent.findIndex(entry => Number(entry.queuedAt) < Number(run.queuedAt))
    if (position >= 0) recent.splice(position, 0, clean)
    else if (recent.length < 5) recent.push(clean)
    if (recent.length > 5) recent.pop()
  }
  return recent
}
function sameHost(origin: string, host: string | undefined): boolean {
  try { const url = new URL(origin); return ['http:','https:'].includes(url.protocol) && url.host === host } catch { return false }
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += data.length
    if (size > 32768) throw new Error('Request body too large')
    chunks.push(data)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Invalid JSON') }
}
