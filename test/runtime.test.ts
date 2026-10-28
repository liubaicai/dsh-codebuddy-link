import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveConfig } from '../src/config.ts'
import { resolveEffort } from '../src/effort.ts'
import { CallRuntime } from '../src/runtime.ts'
import type { runCodeBuddy, BridgeEvent } from '../src/runner.ts'

const request = { prompt: 'SECRET-PROMPT', cwd: 'SECRET-PATH', authToken: 'SECRET-TOKEN', model: 'hy3', effort: 'high' }
async function collect(events: AsyncIterable<BridgeEvent>) { const result = []; for await (const event of events) result.push(event); return result }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

test('shared FIFO bounds both call paths and records sanitized metadata', async () => {
  const cfg = resolveConfig({ maxConcurrency: 1, modelContext: { hy3: 262144 } }, {})
  const runtime = new CallRuntime(cfg), gate = deferred(), started = deferred(), order: string[] = []
  const runner: typeof runCodeBuddy = async function* (req) {
    order.push(req.prompt); req.onSpawn?.(); started.resolve()
    if (req.prompt === 'SECRET-PROMPT') await gate.promise
    yield { type: 'metadata', model: 'returned-model', totalCredits: 0, totalCostUsd: 0.1 }
    yield { type: 'text', delta: 'SECRET-OUTPUT' }
    yield { type: 'result', text: 'SECRET-OUTPUT' }
  }
  const first = collect(runtime.run(request, 'model', runner)); await started.promise
  const second = collect(runtime.run({ ...request, prompt: 'second' }, 'ask', runner))
  const third = collect(runtime.run({ ...request, prompt: 'third' }, 'model', runner))
  assert.deepEqual(runtime.snapshots().map(run => [run.state, run.queuePosition]), [['queued', 2], ['queued', 1], ['waiting', 0]])
  assert.deepEqual(order, ['SECRET-PROMPT'])
  gate.resolve(); await Promise.all([first, second, third])
  assert.deepEqual(order, ['SECRET-PROMPT', 'second', 'third'])
  const snapshots = runtime.snapshots()
  assert.ok(snapshots.every(run => run.state === 'completed' && run.returnedModel === 'returned-model' && run.totalCredits === 0 && run.reasoningConfirmed === false && !run.warning))
  assert.equal(snapshots.find(run => run.source === 'ask')?.contextWindow, undefined)
  assert.equal(snapshots.at(-1)?.contextWindow, 262144)
  assert.equal(snapshots.at(-1)?.contextSource, 'model')
  assert.doesNotMatch(JSON.stringify(snapshots), /SECRET/)
  snapshots[0]!.state = 'failed'
  assert.equal(runtime.snapshots()[0]!.state, 'completed')
})

test('queued abort and timeout never start a process and do not leak slots', async () => {
  const cfg = resolveConfig({ maxConcurrency: 1, queueTimeoutMs: 30 }, {})
  const runtime = new CallRuntime(cfg), gate = deferred(), started = deferred()
  let spawned = 0
  const runner: typeof runCodeBuddy = async function* (req) { spawned++; req.onSpawn?.(); started.resolve(); await gate.promise; yield { type: 'result', text: '' } }
  const first = collect(runtime.run(request, 'model', runner)); await started.promise
  const controller = new AbortController()
  const aborted = assert.rejects(collect(runtime.run({ ...request, signal: controller.signal }, 'ask', runner)), { name: 'AbortError' })
  controller.abort(); await aborted
  await assert.rejects(collect(runtime.run(request, 'ask', runner)), { name: 'QueueTimeoutError' })
  assert.equal(spawned, 1)
  assert.deepEqual(runtime.snapshots().slice(0, 2).map(run => run.failure), ['queue-timeout', 'aborted'])
  gate.resolve(); await first
  await collect(runtime.run(request, 'ask', runner)); assert.equal(spawned, 2)
})

test('silence warning ignores init metadata and clears on meaningful progress', async () => {
  const cfg = resolveConfig({ stallWarnMs: 1 }, {}), runtime = new CallRuntime(cfg)
  const iterator = runtime.run(request, 'model', async function* (req) {
    req.onSpawn?.(); yield { type: 'metadata', model: 'hy3' }
    yield { type: 'text', delta: 'content' }
    yield { type: 'result', text: '' }
  })
  await iterator.next(); await delay(10)
  assert.equal(runtime.snapshots()[0]!.state, 'waiting')
  assert.equal(runtime.snapshots()[0]!.warning, true)
  cfg.stallWarnMs = 60000
  await iterator.next()
  assert.equal(runtime.snapshots()[0]!.state, 'responding')
  assert.equal(runtime.snapshots()[0]!.warning, false)
  await iterator.return(undefined)
  assert.equal(runtime.snapshots()[0]!.state, 'cancelled')
})

test('failure and validation errors are classified without leaking details; queue remains usable', async () => {
  const runtime = new CallRuntime(resolveConfig({ maxConcurrency: 1 }, {}))
  const runner: typeof runCodeBuddy = async function* () { throw new Error('SECRET-ERROR'); yield { type: 'result', text: '' } }
  await assert.rejects(collect(runtime.run(request, 'model', runner)), /SECRET-ERROR/)
  assert.equal(runtime.snapshots()[0]!.failure, 'error')
  assert.doesNotMatch(JSON.stringify(runtime.snapshots()), /SECRET/)
  await assert.rejects(collect(runtime.run(request, 'model', async function* () { yield { type: 'result', text: 'invalid' } }, () => { throw new Error('Invalid envelope') })))
  assert.equal(runtime.snapshots()[0]!.state, 'failed')
  await collect(runtime.run(request, 'ask', async function* () { yield { type: 'result', text: 'ok' } }))
  assert.equal(runtime.snapshots()[0]!.state, 'completed')
})

test('runtime retains only five recent records and rejects unsafe metadata', async () => {
  const runtime = new CallRuntime(resolveConfig({}, {}))
  const runner: typeof runCodeBuddy = async function* () {
    yield { type: 'metadata', model: 'unsafe\n', totalCredits: NaN, totalCostUsd: -1 }
    yield { type: 'result', text: 'ok' }
  }
  for (let i = 0; i < 55; i++) await collect(runtime.run({ ...request, model: undefined }, 'model', runner))
  const snapshots = runtime.snapshots()
  assert.equal(snapshots.length, 5)
  assert.ok(snapshots.every(run => run.returnedModel === undefined && run.totalCredits === undefined && run.totalCostUsd === undefined && run.contextSource === 'fallback'))
})

test('pre-abort does not invoke CLI and bounded queue rejects overflow', async () => {
  const runtime = new CallRuntime(resolveConfig({ maxConcurrency: 1 }, {})), stop = new AbortController()
  stop.abort()
  let calls = 0
  const gate = deferred(), started = deferred()
  const runner: typeof runCodeBuddy = async function* () { calls++; started.resolve(); await gate.promise; yield { type: 'result', text: '' } }
  await assert.rejects(collect(runtime.run({ ...request, signal: stop.signal }, 'ask', runner)), { name: 'AbortError' })
  assert.equal(calls, 0)
  const first = collect(runtime.run(request, 'model', runner)); await started.promise
  const queued = Array.from({ length: 64 }, () => collect(runtime.run(request, 'ask', runner)))
  await assert.rejects(collect(runtime.run(request, 'ask', runner)), { name: 'QueueFullError' })
  gate.resolve(); await Promise.all([first, ...queued]); assert.equal(calls, 65)
})

test('five-record retention never cancels evicted live calls or changes FIFO scheduling', async () => {
  const runtime = new CallRuntime(resolveConfig({ maxConcurrency: 1 }, {}))
  const gate = deferred(), started = deferred(), order: string[] = []
  const runner: typeof runCodeBuddy = async function* (req) {
    order.push(req.model!); req.onSpawn?.(); started.resolve()
    await gate.promise
    yield { type: 'result', text: '' }
  }
  const first = collect(runtime.run({ ...request, model: 'call-0' }, 'model', runner))
  await started.promise
  const queued = Array.from({ length: 7 }, (_, i) => collect(runtime.run({ ...request, model: `call-${i + 1}` }, 'ask', runner)))
  const expected = ['call-7', 'call-6', 'call-5', 'call-4', 'call-3']
  assert.deepEqual(runtime.snapshots().map(run => run.requestedModel), expected)
  assert.deepEqual(runtime.snapshots().map(run => run.queuePosition), [7, 6, 5, 4, 3])
  gate.resolve(); await Promise.all([first, ...queued])
  assert.deepEqual(order, Array.from({ length: 8 }, (_, i) => `call-${i}`))
  assert.deepEqual(runtime.snapshots().map(run => run.requestedModel), expected)
  assert.ok(runtime.snapshots().every(run => run.state === 'completed'))
  await collect(runtime.run({ ...request, model: 'call-8' }, 'model', runner))
  assert.deepEqual(runtime.snapshots().map(run => run.requestedModel), ['call-8', ...expected.slice(0, 4)])
})

test('both paths use strict shared effort precedence and explicit auto', () => {
  assert.equal(resolveEffort(undefined, 'high'), 'high')
  assert.equal(resolveEffort('low', 'high'), 'low')
  assert.equal(resolveEffort('auto', 'high'), undefined)
  assert.equal(resolveEffort(undefined, 'auto'), undefined)
  for (const invalid of ['mega', '', null, 3]) assert.throws(() => resolveEffort(invalid, 'high'), /Unsupported reasoning effort/)
})
