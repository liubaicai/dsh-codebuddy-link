export interface AccountSummary {
  id: string
  name: string
  enabled: boolean
  authState: 'ready' | 'auth-required'
}

export interface AccountSnapshot {
  mode: 'fixed' | 'pool'
  selectedAccountId?: string
  accounts: AccountSummary[]
  managed?: boolean
}

export interface AccountLease {
  accountId: string
  accountName: string
  authToken: string
  /** Release only after the caller has finished child/process/transport cleanup. Idempotent. */
  release(): void
}

export interface AccountSchedulerOptions {
  snapshot(): Promise<AccountSnapshot>
  readCredential(id: string): Promise<{ accessToken: string; uid: string } | undefined>
  /** Read once per acquisition; defaults to 60 seconds. */
  queueTimeoutMs?: () => number
  maxPerAccount?: number
  /** Maximum retained session bindings (LRU); zero disables idle affinity. Default 1024. */
  maxAffinity?: number
  /** Only explicit false disallows a model. Discovery catalogs are NOT entitlement lists. */
  isModelAllowed?: (account: AccountSummary, model: string) => boolean | undefined
}

export interface AccountAcquireOptions {
  sessionId?: string
  model?: string
  signal?: AbortSignal
}

interface Waiter {
  request: AccountAcquireOptions
  accountId?: string
  mode?: AccountSnapshot['mode']
  starting: boolean
  settled: boolean
  unreserve?: () => void
  cleanup(): void
  resolve(lease: AccountLease): void
  reject(error: Error): void
}

class SchedulerFailure extends Error {}

function failure(name: string, message: string): Error {
  const error = new SchedulerFailure(message)
  error.name = name
  return error
}
const selectionError = (message: string) => failure('AccountSelectionError', message)

/**
 * Process-local account scheduling only: never invokes, retries, or replays an operation.
 * A queued choice is pinned, then revalidated before grant. Reconfiguration invalidates
 * that acquisition rather than silently switching its identity. New acquisitions may
 * rebind an ineligible/evicted session. No credentials are kept in scheduler state.
 */
export class AccountScheduler {
  private readonly options: AccountSchedulerOptions
  private readonly maxPerAccount: number
  private readonly maxAffinity: number
  private readonly affinity = new Map<string, string>()
  private readonly active = new Map<string, number>()
  private readonly activeBindings = new Map<string, Map<string, number>>()
  private readonly queue: Waiter[] = []
  private lastAccountId: string | undefined
  private revision = 0
  private pumping = false
  private dirty = false

  constructor(options: AccountSchedulerOptions) {
    this.options = options
    this.maxPerAccount = options.maxPerAccount ?? 1
    this.maxAffinity = options.maxAffinity ?? 1024
    if (!Number.isSafeInteger(this.maxPerAccount) || this.maxPerAccount < 1
      || !Number.isSafeInteger(this.maxAffinity) || this.maxAffinity < 0) {
      throw failure('AccountConfigurationError', 'Invalid account scheduler capacity')
    }
  }

  /** Detached token-free counts, including slots reserved while credentials are read. */
  activeCounts(): Record<string, number> { return Object.fromEntries(this.active) }

  /** Wake queued acquisitions after account settings or authentication state changes. */
  refresh(): void { this.revision++; this.wake() }

  acquire(request: AccountAcquireOptions = {}): Promise<AccountLease> {
    if (request.signal?.aborted) return Promise.reject(failure('AbortError', 'Account acquisition aborted'))
    if (this.queue.length >= 64) return Promise.reject(failure('QueueFullError', 'Account queue is full (64 waiting calls)'))
    let timeout: number
    try {
      timeout = this.options.queueTimeoutMs?.() ?? 60_000
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new Error()
    } catch {
      return Promise.reject(failure('AccountConfigurationError', 'Invalid account queue timeout'))
    }
    // Copy the input so later caller mutation cannot change the queued identity or signal.
    request = { ...request }
    return new Promise<AccountLease>((resolve, reject) => {
      const signal = request.signal
      const abort = () => this.fail(waiter, failure('AbortError', 'Account acquisition aborted'))
      const timer = setTimeout(() => this.fail(waiter, failure('QueueTimeoutError', 'Account queue wait timed out')), timeout)
      const waiter: Waiter = {
        request, starting: false, settled: false, resolve, reject,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) },
      }
      this.queue.push(waiter)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else this.wake()
    })
  }

  private wake(): void {
    this.dirty = true
    if (!this.pumping) void this.pump()
  }

  private async snapshot(): Promise<{ value: AccountSnapshot; revision: number }> {
    // A refresh during an asynchronous settings read makes its result stale.
    for (;;) {
      const revision = this.revision
      let value: AccountSnapshot
      try {
        const raw = await this.options.snapshot()
        if (!raw || (raw.mode !== 'fixed' && raw.mode !== 'pool') || !Array.isArray(raw.accounts)) throw new Error()
        const ids = new Set<string>()
        const accounts = raw.accounts.map(account => {
          if (!account || typeof account.id !== 'string' || !account.id || ids.has(account.id)
            || typeof account.name !== 'string' || typeof account.enabled !== 'boolean'
            || (account.authState !== 'ready' && account.authState !== 'auth-required')) throw new Error()
          ids.add(account.id)
          return { id: account.id, name: account.name, enabled: account.enabled, authState: account.authState }
        })
        value = { mode: raw.mode, selectedAccountId: raw.selectedAccountId, managed: raw.managed, accounts }
      } catch {
        throw failure('AccountSnapshotError', 'Unable to read account settings')
      }
      if (revision === this.revision) return { value, revision }
    }
  }

  private allowed(account: AccountSummary, model?: string): boolean {
    if (!account.enabled || account.authState !== 'ready') return false
    if (!model || !this.options.isModelAllowed) return true
    try { return this.options.isModelAllowed(account, model) !== false }
    catch { throw failure('AccountModelError', 'Unable to check account model eligibility') }
  }

  private validate(snapshot: AccountSnapshot, waiter: Waiter): AccountSummary {
    if (snapshot.managed === false) throw selectionError('Managed account mode is not enabled')
    if (waiter.mode !== snapshot.mode
      || (snapshot.mode === 'fixed' && snapshot.selectedAccountId !== waiter.accountId)) {
      throw selectionError('Account selection changed while waiting; submit a new request')
    }
    const account = snapshot.accounts.find(item => item.id === waiter.accountId)
    if (!account) throw selectionError('Selected account is missing or was removed')
    if (!account.enabled) throw selectionError('Selected account is disabled')
    if (account.authState !== 'ready') throw selectionError('Selected account requires authentication')
    if (!this.allowed(account, waiter.request.model)) throw selectionError('Selected account does not allow the requested model')
    return account
  }

  private choose(snapshot: AccountSnapshot, waiter: Waiter): void {
    if (snapshot.managed === false) throw selectionError('Managed account mode is not enabled')
    waiter.mode = snapshot.mode
    if (snapshot.mode === 'fixed') {
      if (!snapshot.selectedAccountId) throw selectionError('No fixed account is selected')
      waiter.accountId = snapshot.selectedAccountId
      this.validate(snapshot, waiter)
      return
    }
    const eligible = snapshot.accounts.filter(account => this.allowed(account, waiter.request.model))
    if (!eligible.length) throw selectionError('No eligible accounts are available in the pool')
    const session = waiter.request.sessionId
    // Pending bindings also prevent concurrent acquisitions of a just-evicted session
    // from diverging while waiting. They disappear with the bounded queue entries.
    const binding = session ? [...(this.activeBindings.get(session)?.keys() ?? [])].find(id => eligible.some(row => row.id === id))
      ?? this.queue.find(item => item !== waiter && item.request.sessionId === session && item.accountId)?.accountId
      ?? this.affinity.get(session) : undefined
    let account = eligible.find(item => item.id === binding)
    if (!account) {
      account = eligible[(eligible.findIndex(item => item.id === this.lastAccountId) + 1) % eligible.length]!
      this.lastAccountId = account.id
    }
    waiter.accountId = account.id
    if (session && this.maxAffinity > 0) {
      this.affinity.delete(session)
      this.affinity.set(session, account.id)
      while (this.affinity.size > this.maxAffinity) this.affinity.delete(this.affinity.keys().next().value!)
    }
  }

  private async pump(): Promise<void> {
    this.pumping = true
    try {
      while (this.dirty && this.queue.length) {
        this.dirty = false
        let snapshot: AccountSnapshot
        try {
          const result = await this.snapshot()
          if (result.revision !== this.revision) { this.dirty = true; continue }
          snapshot = result.value
        } catch {
          for (const waiter of [...this.queue]) this.fail(waiter, failure('AccountSnapshotError', 'Unable to read account settings'))
          continue
        }
        const ids = new Set(snapshot.accounts.filter(account => account.enabled && account.authState === 'ready').map(account => account.id))
        for (const [session, id] of this.affinity) if (!ids.has(id)) this.affinity.delete(session)
        for (const waiter of [...this.queue]) {
          if (waiter.settled) continue
          try {
            if (waiter.accountId === undefined) this.choose(snapshot, waiter)
            const account = this.validate(snapshot, waiter)
            if (waiter.settled || waiter.starting || (this.active.get(account.id) ?? 0) >= this.maxPerAccount) continue
            waiter.starting = true
            waiter.unreserve = this.reserve(account.id, waiter.request.sessionId)
            // Credentials for one account must not head-of-line block other accounts.
            void this.grant(waiter)
          } catch (error) {
            // All errors produced by choose/validate are static, sanitized errors.
            this.fail(waiter, error instanceof SchedulerFailure ? error : selectionError('Unable to select an account'))
          }
        }
      }
    } finally {
      this.pumping = false
      if (this.dirty && this.queue.length) this.wake()
    }
  }

  private reserve(id: string, session?: string): () => void {
    this.active.set(id, (this.active.get(id) ?? 0) + 1)
    if (session) {
      const bindings = this.activeBindings.get(session) ?? new Map<string, number>()
      bindings.set(id, (bindings.get(id) ?? 0) + 1)
      this.activeBindings.set(session, bindings)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (session) {
        const bindings = this.activeBindings.get(session)!
        const remaining = bindings.get(id)! - 1
        if (remaining > 0) bindings.set(id, remaining)
        else bindings.delete(id)
        if (!bindings.size) this.activeBindings.delete(session)
      }
      const count = (this.active.get(id) ?? 1) - 1
      if (count === 0) this.active.delete(id)
      else this.active.set(id, count)
      this.wake()
    }
  }

  private async grant(waiter: Waiter): Promise<void> {
    try {
      let credential: { accessToken: string; uid: string } | undefined
      try { credential = await this.options.readCredential(waiter.accountId!) }
      catch { throw failure('AccountCredentialError', 'Unable to read selected account credentials; authenticate that account again') }
      if (waiter.settled) return
      const authToken = credential?.accessToken
      const uid = credential?.uid
      if (typeof authToken !== 'string' || !authToken || typeof uid !== 'string' || !uid
        || /[\r\n\0]/.test(authToken) || /[\r\n\0]/.test(uid)) {
        throw failure('AccountCredentialError', 'Selected account credentials are missing or invalid; authenticate that account again')
      }
      let result = await this.snapshot()
      while (result.revision !== this.revision && !waiter.settled) result = await this.snapshot()
      if (waiter.settled) return
      const account = this.validate(result.value, waiter)
      if (waiter.settled) return
      waiter.settled = true
      waiter.cleanup()
      this.remove(waiter)
      const release = waiter.unreserve!
      waiter.unreserve = undefined
      waiter.resolve({ accountId: account.id, accountName: account.name, authToken, release })
    } catch (error) {
      this.fail(waiter, error instanceof SchedulerFailure ? error : failure('AccountCredentialError', 'Unable to acquire account credentials'))
    }
  }

  private remove(waiter: Waiter): void {
    const index = this.queue.indexOf(waiter)
    if (index >= 0) this.queue.splice(index, 1)
  }

  private fail(waiter: Waiter, error: Error): void {
    if (waiter.settled) return
    waiter.settled = true
    waiter.cleanup()
    this.remove(waiter)
    waiter.unreserve?.()
    waiter.unreserve = undefined
    waiter.reject(error)
    this.wake()
  }
}
