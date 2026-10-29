import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm, readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runCodeBuddy, resolveCodeBuddyBin, childEnv, type BridgeEvent } from '../src/runner.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), 'codebuddy bridge '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = join(cwd, 'fake cli.mjs');
  await copyFile(fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url)), bin);
  return { cwd, bin };
}
async function collect(iterator: AsyncIterable<BridgeEvent>): Promise<BridgeEvent[]> {
  const result: BridgeEvent[] = []; for await (const event of iterator) result.push(event); return result;
}

test('runner streams Unicode and unterminated result from a temporary CLI', async t => {
  const f = await fixture(t);
  const events = await collect(runCodeBuddy({ ...f, prompt: '中文😀', timeoutMs: 5000 }));
  assert.deepEqual(events[0], { type: 'text', delta: '中文😀' });
  assert.deepEqual(events.at(-1), { type: 'result', sessionId: 'test-session', text: '中文😀', structuredOutput: { ok: true } });
});
test('argv stays literal, disables tools, supplies optional schema and never resumes', async t => {
  const f = await fixture(t);
  const injection = 'a & echo INJECTED | " b';
  const events = await collect(runCodeBuddy({ ...f, prompt: 'argv', systemPrompt: injection, model: 'm', effort: 'low', jsonSchema: { type: 'object' } }));
  const result = events.at(-1);
  assert.equal(result?.type, 'result');
  if (result?.type !== 'result') return;
  const args: string[] = JSON.parse(result.text);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--system-prompt') + 1], injection);
  assert.equal(args[args.indexOf('--json-schema') + 1], '{"type":"object"}');
  assert.ok(!args.includes('--resume') && !args.includes('--continue'));
});
test('native execution sends exact tools, append prompt and explicit bypass without permission-mode conflict', async t => {
  const f = await fixture(t);
  const events = await collect(runCodeBuddy({ ...f, prompt: 'argv', tools: 'default', appendSystemPrompt: 'native guidance', dangerouslySkipPermissions: true }));
  const result = events.at(-1);
  assert.equal(result?.type, 'result');
  if (result?.type !== 'result') return;
  const args: string[] = JSON.parse(result.text);
  assert.equal(args[args.indexOf('--tools') + 1], 'default');
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'native guidance');
  assert.ok(args.includes('--dangerously-skip-permissions'));
  for (const flag of ['--permission-mode', '--system-prompt', '--json-schema', '--resume', '--continue']) assert.ok(!args.includes(flag), flag);
});
test('nonzero exits, protocol errors, malformed output and missing results throw safely', async t => {
  const f = await fixture(t);
  for (const prompt of ['error', 'protocol-error', 'malformed', 'missing']) {
    await assert.rejects(collect(runCodeBuddy({ ...f, prompt })), error => error instanceof Error && !error.message.includes('SECRET_TOKEN'));
  }
});
test('pre-abort, active abort and timeout are distinct errors', async t => {
  const f = await fixture(t);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(collect(runCodeBuddy({ ...f, prompt: 'hang', signal: pre.signal })), { name: 'AbortError' });
  const controller = new AbortController();
  const running = collect(runCodeBuddy({ ...f, prompt: 'hang', signal: controller.signal }));
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(running, { name: 'AbortError' });
  await assert.rejects(collect(runCodeBuddy({ ...f, prompt: 'hang', timeoutMs: 100 })), { name: 'TimeoutError' });
});
test('abort kills spawned descendant process', async t => {
  const f = await fixture(t);
  const pidFile = join(f.cwd, 'child.pid');
  const controller = new AbortController();
  const outcome = collect(runCodeBuddy({ ...f, prompt: `tree:${pidFile}`, signal: controller.signal, timeoutMs: 10000 })).catch(error => error);
  let pid = 0;
  for (let i = 0; i < 100; i++) {
    try { pid = Number(await readFile(pidFile, 'utf8')); break; } catch { await delay(30); }
  }
  controller.abort();
  assert.equal((await outcome).name, 'AbortError');
  assert.ok(pid > 0);
  let alive = true;
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { alive = false; break; }
    await delay(20);
  }
  assert.equal(alive, false, 'descendant must not survive cancellation');
});
test('consumer early return kills the process tree', async t => {
  const f = await fixture(t);
  const pidFile = join(f.cwd, 'early-child.pid');
  for await (const event of runCodeBuddy({ ...f, prompt: `yield-tree:${pidFile}` })) {
    assert.equal(event.type, 'text');
    break;
  }
  const pid = Number(await readFile(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { alive = false; break; }
    await delay(20);
  }
  assert.equal(alive, false);
});
test('Windows npm shim resolves to JavaScript without shell execution', async t => {
  const f = await fixture(t);
  const target = join(f.cwd, 'node_modules', 'fake', 'cli.js');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, '// fake');
  const shim = join(f.cwd, 'buddy.cmd');
  await writeFile(shim, '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\fake\\cli.js" %*\r\n');
  // Explicit Windows shims resolve on all platforms (useful for portable tests).
  if (process.platform !== 'win32') { const { chmod } = await import('node:fs/promises'); await chmod(shim, 0o755); }
  const resolved = await resolveCodeBuddyBin(shim, f.cwd);
  assert.equal(resolved.command, process.execPath);
  // Windows runners can expose TEMP through an 8.3 alias; resolver canonicalizes it.
  assert.equal(resolved.args[0], await realpath(target));
});
test('childEnv forces ELECTRON_RUN_AS_NODE so Electron hosts spawn plain Node children', () => {
  const env = childEnv();
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal('CODEBUDDY_AUTH_TOKEN' in env, false);
  assert.equal(childEnv('tok').CODEBUDDY_AUTH_TOKEN, 'tok');
  // Windows preserves the original casing (Path) when spreading process.env.
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
  assert.equal(pathKey ? env[pathKey] : undefined, process.env.PATH);
  const original = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '0';
  try { assert.equal(childEnv().ELECTRON_RUN_AS_NODE, '1'); }
  finally { if (original === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = original; }
});
test('authToken reaches the CLI child environment via CODEBUDDY_AUTH_TOKEN', async t => {
  const f = await fixture(t);
  const events = await collect(runCodeBuddy({ ...f, prompt: 'env', authToken: 'tok-123', timeoutMs: 5000 }));
  const last = events.at(-1), absentRun = await collect(runCodeBuddy({ ...f, prompt: 'env', timeoutMs: 5000 }));
  const absentLast = absentRun.at(-1);
  assert.equal(last?.type === 'result' ? last.text : undefined, 'tok-123');
  assert.equal(absentLast?.type === 'result' ? absentLast.text : undefined, 'ABSENT');
});
