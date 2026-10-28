import { randomUUID } from 'node:crypto'
import { isModelIdentifier as identifier } from './metadata.ts'
import { isCodeBuddyEffort, type PluginConfig } from './config.ts'
import { runCodeBuddy, type CodeBuddyRequest, type BridgeEvent } from './runner.ts'

export interface RunSnapshot {
  id: string
  source: 'model' | 'ask'
  state: 'queued' | 'starting' | 'waiting' | 'responding' | 'completed' | 'failed' | 'cancelled'
  requestedModel: string
  returnedModel?: string
  requestedEffort: string
  contextWindow?: number
  contextSource?: 'model' | 'fallback'
  contextOverrideSent: false
  reasoningConfirmed: false
  queuedAt: number
  startedAt?: number
  lastProgressAt?: number
  endedAt?: number
  warning: boolean
  queuePosition: number
  totalCredits?: number
  totalCostUsd?: number
  failure?: 'timeout' | 'queue-timeout' | 'aborted' | 'error'
}
interface Waiter { id: string; grant(): void }
const terminal = (state: RunSnapshot['state']) => ['completed', 'failed', 'cancelled'].includes(state)
function error(name: string, message: string): Error { const value = new Error(message); value.name = name; return value }

/** Process-local FIFO shared by provider and ask calls. Never stores prompts, argv, paths or errors. */
export class CallRuntime {
  private readonly config: PluginConfig
  private readonly records = new Map<string, RunSnapshot>()
  private readonly queue: Waiter[] = []
  private active = 0
  constructor(config: PluginConfig) { this.config = config }
  snapshots(): RunSnapshot[] {
    const now = Date.now()
    return [...this.records.values()].reverse().map(record => ({
      ...record,
      queuePosition: record.state === 'queued' ? this.queue.findIndex(item => item.id === record.id) + 1 : 0,
      warning: !terminal(record.state) && record.state !== 'queued' && this.config.stallWarnMs > 0
        && now - (record.lastProgressAt ?? record.startedAt ?? now) >= this.config.stallWarnMs,
    }))
  }
  private prune(): void {
    // Diagnostic retention is independent of scheduling: evicted live calls keep
    // their local record and queue slot, but never re-enter the recent history.
    for (const id of [...this.records.keys()].slice(0, Math.max(0, this.records.size - 5))) this.records.delete(id)
  }
  /** Re-evaluate live concurrency changes without interrupting active calls. */
  refresh(): void { this.pump() }
  private pump(): void {
    while (this.queue.length && this.active < this.config.maxConcurrency) this.queue.shift()!.grant()
  }
  private acquire(id: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(error('AbortError', 'CodeBuddy request aborted'))
    if (this.queue.length >= 64) return Promise.reject(error('QueueFullError', 'CodeBuddy queue is full (64 waiting calls)'))
    return new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      const remove = () => { const at = this.queue.indexOf(waiter); if (at >= 0) this.queue.splice(at, 1) }
      const fail = (cause: Error) => { if (settled) return; settled = true; cleanup(); remove(); reject(cause); this.pump() }
      const abort = () => fail(error('AbortError', 'CodeBuddy request aborted'))
      const waiter: Waiter = { id, grant: () => {
        if (settled) return
        settled = true; cleanup(); this.active++
        let released = false
        resolve(() => { if (released) return; released = true; this.active--; this.pump() })
      } }
      this.queue.push(waiter)
      timer = setTimeout(() => fail(error('QueueTimeoutError', 'CodeBuddy queue wait timed out')), this.config.queueTimeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      // Covers a signal aborted between the initial check and listener registration.
      if (signal?.aborted) abort(); else this.pump()
    })
  }
  async *run(request: CodeBuddyRequest, source: 'model' | 'ask', runner: typeof runCodeBuddy = runCodeBuddy,
    validate?: (event: Extract<BridgeEvent, { type: 'result' }>) => void): AsyncGenerator<BridgeEvent> {
    const requestedModel = identifier(request.model) ? request.model : 'default'
    const modelContext = requestedModel !== 'default' ? this.config.modelContext[requestedModel] : undefined
    const record: RunSnapshot = {
      id: randomUUID(), source, state: 'queued', requestedModel,
      requestedEffort: isCodeBuddyEffort(request.effort) ? request.effort : 'auto',
      ...(source === 'model' ? { contextWindow: modelContext ?? this.config.contextWindow, contextSource: modelContext ? 'model' as const : 'fallback' as const } : {}),
      contextOverrideSent: false, reasoningConfirmed: false, queuedAt: Date.now(), warning: false, queuePosition: 0,
    }
    this.records.set(record.id, record)
    this.prune()
    let release: (() => void) | undefined
    try {
      release = await this.acquire(record.id, request.signal)
      if (request.signal?.aborted) throw error('AbortError', 'CodeBuddy request aborted')
      record.state = 'starting'; record.startedAt = Date.now()
      for await (const event of runner({ ...request, onSpawn: () => {
        record.state = 'waiting'
        request.onSpawn?.()
      } })) {
        if ((event.type === 'text' || event.type === 'reasoning') && event.delta.length > 0
          || event.type === 'tool-start' || event.type === 'tool-end') {
          record.state = 'responding'; record.lastProgressAt = Date.now()
        }
        if (event.type === 'metadata') {
          if (identifier(event.model)) record.returnedModel = event.model
          if (typeof event.totalCredits === 'number' && Number.isFinite(event.totalCredits) && event.totalCredits >= 0) record.totalCredits = event.totalCredits
          if (typeof event.totalCostUsd === 'number' && Number.isFinite(event.totalCostUsd) && event.totalCostUsd >= 0) record.totalCostUsd = event.totalCostUsd
        }
        if (event.type === 'result') validate?.(event)
        yield event
      }
      record.state = 'completed'
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : ''
      record.state = name === 'AbortError' || request.signal?.aborted ? 'cancelled' : 'failed'
      record.failure = record.state === 'cancelled' ? 'aborted' : name === 'QueueTimeoutError' ? 'queue-timeout' : name === 'TimeoutError' ? 'timeout' : 'error'
      throw cause
    } finally {
      if (!terminal(record.state)) { record.state = 'cancelled'; record.failure = 'aborted' }
      record.endedAt = Date.now(); release?.(); this.prune()
    }
  }
}
