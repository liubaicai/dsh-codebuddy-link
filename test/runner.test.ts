import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm, readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
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
test('runner accepts bounded bare model IDs and rejects unsafe requests before spawning', async t => {
  const f = await fixture(t);
  for (const length of [128, 129, 256]) {
    const model = 'm'.repeat(length);
    const events = await collect(runCodeBuddy({ ...f, prompt: 'argv', model }));
    const result = events.at(-1);
    assert.equal(result?.type, 'result');
    if (result?.type !== 'result') continue;
    const args: string[] = JSON.parse(result.text);
    assert.equal(args[args.indexOf('--model') + 1], model);
  }
  for (const model of ['m'.repeat(257), 'provider/model', 'https://host/model', '../model', 'C:model', 'model\n']) {
    let spawned = false;
    await assert.rejects(collect(runCodeBuddy({ ...f, prompt: 'argv', model, onSpawn: () => { spawned = true; } })), /Invalid model id/);
    assert.equal(spawned, false);
  }
});

async function windowsPathFixture(t: { after(fn: () => Promise<void>): void }) {
  const f = await fixture(t);
  const first = join(f.cwd, 'first'), later = join(f.cwd, 'later');
  await mkdir(first); await mkdir(later);
  const original = process.env.PATH;
  process.env.PATH = [first, later].join(delimiter);
  t.after(async () => { if (original === undefined) delete process.env.PATH; else process.env.PATH = original; });
  const target = join(first, 'node_modules', 'fake', 'cli.js');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, 'throw Error("must not execute during resolution")');
  return { ...f, first, later, target };
}

test('Windows PATH skips an unsupported extensionless shell launcher for its npm cmd sibling', { skip: process.platform !== 'win32' }, async t => {
  const f = await windowsPathFixture(t);
  await writeFile(join(f.first, 'buddy'), '#!/bin/sh\necho UNSUPPORTED');
  await writeFile(join(f.first, 'buddy.cmd'), '@ECHO off\r\n"node" "%dp0%\\node_modules\\fake\\cli.js" %*');
  assert.deepEqual(await resolveCodeBuddyBin('buddy'), { command: process.execPath, args: [await realpath(f.target)] });
  await assert.rejects(resolveCodeBuddyBin(join(f.first, 'buddy')), /Unsupported CodeBuddy launcher/);
  await assert.rejects(resolveCodeBuddyBin('./first/buddy', f.cwd), /Unsupported CodeBuddy launcher/);
});

test('Windows PATH tries native exe siblings and later installations without a shell', { skip: process.platform !== 'win32' }, async t => {
  const f = await windowsPathFixture(t);
  await writeFile(join(f.first, 'buddy'), '#!/bin/sh\necho UNSUPPORTED');
  const exe = join(f.first, 'buddy.exe');
  await copyFile(process.execPath, exe);
  assert.deepEqual(await resolveCodeBuddyBin('buddy'), { command: await realpath(exe), args: [] });
  await writeFile(join(f.first, 'laterbuddy'), 'unsupported');
  await writeFile(join(f.first, 'laterbuddy.cmd'), 'echo UNSUPPORTED');
  const later = join(f.later, 'laterbuddy.exe');
  await copyFile(process.execPath, later);
  assert.deepEqual(await resolveCodeBuddyBin('laterbuddy'), { command: await realpath(later), args: [] });
  // A nonexistent explicit pin must not silently substitute a sibling either.
  await assert.rejects(resolveCodeBuddyBin(join(f.first, 'missing')), /not found/);
  await writeFile(join(f.first, 'missing.cmd'), '@ECHO off\r\n"node" "%dp0%\\node_modules\\fake\\cli.js" %*');
  await assert.rejects(resolveCodeBuddyBin(join(f.first, 'missing')), /not found/);
});

test('Windows PATH skips malformed npm shim targets but explicit bad shims fail closed', { skip: process.platform !== 'win32' }, async t => {
  const f = await windowsPathFixture(t);
  const valid = join(f.later, 'buddy.exe');
  await copyFile(process.execPath, valid);
  const shim = join(f.first, 'buddy.cmd');
  const shellTarget = join(f.first, 'node_modules', 'fake', 'shell.cmd');
  const noNode = join(f.first, 'node_modules', 'fake', 'shell');
  await writeFile(shellTarget, 'echo MUST_NOT_EXECUTE');
  await writeFile(noNode, '#!/bin/sh\necho MUST_NOT_EXECUTE');
  for (const target of ['missing.js', '.', 'shell.cmd', 'shell']) {
    await writeFile(shim, `@ECHO off\r\n"node" "%dp0%\\node_modules\\fake\\${target}" %*`);
    assert.deepEqual(await resolveCodeBuddyBin('buddy'), { command: await realpath(valid), args: [] });
    await assert.rejects(resolveCodeBuddyBin(shim));
  }
  const nodeTarget = join(f.first, 'node_modules', 'fake', 'node-entry');
  await writeFile(nodeTarget, '#!/usr/bin/env node\nthrow Error("must not execute")');
  await writeFile(shim, '@ECHO off\r\n"node" "%dp0%\\node_modules\\fake\\node-entry" %*');
  assert.deepEqual(await resolveCodeBuddyBin(shim), { command: process.execPath, args: [await realpath(nodeTarget)] });
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
test('childEnv strips inherited authentication without mutating the host environment', () => {
  const keys = ['CODEBUDDY_AUTH_TOKEN', 'codebuddy_auth_token'];
  const originals = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = 'host-only-secret';
    for (const token of [undefined, '', 'selected-account-token']) {
      const env = childEnv(token);
      const authKeys = Object.keys(env).filter(key => key.toUpperCase() === 'CODEBUDDY_AUTH_TOKEN');
      assert.deepEqual(authKeys, token ? ['CODEBUDDY_AUTH_TOKEN'] : []);
      assert.equal(env.CODEBUDDY_AUTH_TOKEN, token || undefined);
    }
    for (const key of keys) assert.equal(process.env[key], 'host-only-secret');
  } finally {
    for (const [index, key] of keys.entries()) {
      if (originals[index] === undefined) delete process.env[key]; else process.env[key] = originals[index];
    }
  }
});

test('authToken reaches the CLI child environment via CODEBUDDY_AUTH_TOKEN', async t => {
  const original = process.env.CODEBUDDY_AUTH_TOKEN;
  process.env.CODEBUDDY_AUTH_TOKEN = 'inherited-host-token';
  t.after(() => { if (original === undefined) delete process.env.CODEBUDDY_AUTH_TOKEN; else process.env.CODEBUDDY_AUTH_TOKEN = original; });
  const f = await fixture(t);
  const events = await collect(runCodeBuddy({ ...f, prompt: 'env', authToken: 'tok-123', timeoutMs: 5000 }));
  const last = events.at(-1), absentRun = await collect(runCodeBuddy({ ...f, prompt: 'env', timeoutMs: 5000 }));
  const absentLast = absentRun.at(-1);
  assert.equal(last?.type === 'result' ? last.text : undefined, 'tok-123');
  assert.equal(absentLast?.type === 'result' ? absentLast.text : undefined, 'ABSENT');
});
