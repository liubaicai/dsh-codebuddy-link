import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('plugin registers provider, command and standalone tool; disabled mode stays inert', () => {
  const providers: unknown[] = []; const tools: any[] = []; const commands: any[] = []
  const context = {
    llm: { registerAdapter: (...args: unknown[]) => providers.push(args) },
    commands: { register: (command: unknown) => commands.push(command) },
    tools: { register: (tool: unknown) => tools.push(tool) },
    get: () => undefined,
    inject: (_deps: string[], callback: (ctx: unknown) => void) => callback(context),
  }
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'cb-plugin-'))
  process.env.DSH_HOME = home
  try {
  apply(context as unknown as Context, {enabled:true, askTool:true})
  assert.equal(providers.length,1); assert.equal(tools.length,1)
  assert.equal(tools[0].name,'codebuddy_ask')
  assert.equal(commands[0].handler({rawInput:'status'}).kind,'success')
  assert.match(commands[0].handler({rawInput:'models'}).text,/codebuddy\/default/)
  assert.equal(commands[0].handler({rawInput:'invalid'}).kind,'error')
  apply(context as unknown as Context, {enabled:false})
  assert.equal(providers.length,1); assert.equal(tools.length,1); assert.equal(commands.length,2)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, {recursive:true, force:true})
  }
})
