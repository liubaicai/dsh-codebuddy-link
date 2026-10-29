import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseResponse } from '../src/prompt.ts'
import { CodeBuddyAdapter, type Runner } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const raw = readFileSync(new URL('./fixtures/deepseek-dsml.txt', import.meta.url), 'utf8')
const tools = [{ name: 'pwsh', description: 'PowerShell', parameters: {} }]
const doc = (parameters: string, name = 'pwsh') => `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="${name}">${parameters}</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`
const param = (name: string, value: string, string = true) => `<｜｜DSML｜｜ parameter name="${name}" string="${string}">${value}</｜｜DSML｜｜ parameter>`

test('real deepseek tool-result continuation decodes two calls without executing them', () => {
  const result = parseResponse(raw, tools)
  assert.equal(result.text, '')
  assert.equal(result.toolCalls.length, 2)
  assert.deepEqual(result.toolCalls.map(c => c.name), ['pwsh', 'pwsh'])
  assert.deepEqual(JSON.parse(result.toolCalls[0]!.arguments), {
    command: 'Get-ChildItem "$env:USERPROFILE\\.dsh" -Force -ErrorAction SilentlyContinue | Select-Object Mode,Length,Name | Format-Table -AutoSize',
    description: 'List DSH config directory',
  })
  assert.equal(JSON.parse(result.toolCalls[1]!.arguments).description, 'Find DSH config files')
})

test('DSML retains literal string bytes and JSON typed parameters', () => {
  const literal = '  a\\b\n"quoted" &amp; <value>  '
  const result = parseResponse(doc(param('command', literal) + param('timeoutMs', '1200', false) + param('extra', '{"enabled":true,"list":[1,null]}', false)), tools)
  assert.deepEqual(JSON.parse(result.toolCalls[0]!.arguments), {command: literal, timeoutMs:1200, extra:{enabled:true,list:[1,null]}})
  assert.deepEqual(JSON.parse(parseResponse(doc(''), tools).toolCalls[0]!.arguments), {})
})

test('DSML fails closed for unknown tools, partial calls and ambiguous syntax', () => {
  const bad = [doc('', 'delete'), raw.slice(0, -10), raw + 'trailing', 'example:\n' + raw,
    '```xml\n' + raw + '\n```', '<｜｜DSML｜｜ calls></｜｜DSML｜｜ calls>',
    doc(param('x', '1') + param('x', '2')), doc(param('x', 'undefined', false)),
    doc(param('x', '<｜｜DSML｜｜ invoke name="pwsh">')), doc('unexpected'),
    raw.replace('string="true"', 'string="maybe"'),
    '<｜｜DSML｜｜ calls>' + '<｜｜DSML｜｜ invoke name="pwsh"></｜｜DSML｜｜ invoke>'.repeat(33) + '</｜｜DSML｜｜ calls>',
  ]
  for (const input of bad) assert.throws(() => parseResponse(input, tools))
  const proto = parseResponse(doc(param('__proto__', '{"polluted":true}', false)), tools)
  assert.equal(Object.hasOwn(JSON.parse(proto.toolCalls[0]!.arguments), '__proto__'), true)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
})

test('fixed ACP adapter preserves DSML and JSON finals verbatim without replaying DSH calls', async () => {
  let step = 0
  const finals = [raw, '{"text":"检查完成","toolCalls":[]}']
  const runner: Runner = async function* (request) {
    assert.equal(request.cwd, process.cwd())
    assert.equal(request.tools, 'default')
    assert.equal(request.permissionMode, 'dontAsk')
    assert.equal(request.jsonSchema, undefined)
    assert.equal(request.systemPrompt, undefined)
    assert.doesNotMatch(request.prompt, /Available DSH tools:|DSH transport contract/)
    const text = finals[step++]!
    yield {type: 'text', delta: text}
    yield {type: 'result', text}
  }
  const adapter = new CodeBuddyAdapter(resolveConfig({workspaceRoot:process.cwd()}, {}), runner)
  for (const expected of finals) {
    const out: StreamChunk[] = []
    for await (const c of adapter.stream({provider:'codebuddy',model:'default',messages:[],tools})) out.push(c)
    assert.deepEqual(out.filter(c => c.type === 'text-delta').map(c => c.text), [expected])
    assert.deepEqual(out.filter(c => c.type === 'reasoning-delta').map(c => c.text), [expected])
    assert.equal(out.filter(c => c.type === 'tool-call-delta' || c.type === 'block-start' && c.blockType === 'tool-call' || c.type === 'block-end' && c.block.type === 'tool-call').length, 0)
    assert.equal(out.filter(c => c.type === 'finish').length, 1)
    const finish = out.at(-1)
    assert.equal(finish?.type === 'finish' && finish.reason.kind, 'stop')
  }
  assert.equal(step, 2)
})
