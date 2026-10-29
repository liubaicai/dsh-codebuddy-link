import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { captureAcpDescendants } from '../src/acp-cleanup.ts';

const windows = process.platform === 'win32';
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function dead(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return;
    await delay(20);
  }
  assert.fail(`fixture process ${pid} survived cleanup`);
}
const LEAF = "process.send({pid:process.pid}); setTimeout(()=>process.exit(0),60000);";
const MIDDLE = `
const {spawn}=require('node:child_process');
const leaf=spawn(process.execPath,['-e',${JSON.stringify(LEAF)}],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,detached:true});
leaf.on('message',row=>process.send({pid:process.pid,leaf:row.pid}));
setTimeout(()=>process.exit(0),60000);
`;
const ROOT = `
const {spawn}=require('node:child_process');
const middle=spawn(process.execPath,['-e',${JSON.stringify(MIDDLE)}],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,detached:true});
middle.on('message',row=>process.send(row));
process.on('message',()=>process.exit(0));
setTimeout(()=>process.exit(0),60000);
`;
function fixture(code: string): ChildProcess {
  return spawn(process.execPath, ['-e', code], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}
function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, value?: unknown): void => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(value);
    };
    const onMessage = (value: unknown): void => finish(undefined, value);
    const onError = (): void => finish(new Error('Unable to spawn fixture'));
    const onExit = (): void => finish(new Error('Fixture exited before readiness'));
    const timer = setTimeout(() => finish(new Error('Fixture readiness timeout')), 10000);
    child.once('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}
function stop(pid: number | undefined): void {
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

test('Windows snapshot retains nested descendants after the server exits, without killing unrelated processes', { skip: !windows, timeout: 45000 }, async t => {
  const root = fixture(ROOT);
  const unrelated = fixture(LEAF);
  let middlePid: number | undefined;
  let leafPid: number | undefined;
  t.after(async () => {
    // Independent safety cleanup runs even if the helper under test fails.
    for (const pid of [leafPid, middlePid, root.pid, unrelated.pid]) stop(pid);
    await Promise.all([root.pid, unrelated.pid].filter((pid): pid is number => pid !== undefined).map(dead));
  });
  const [row] = await Promise.all([message(root), message(unrelated)]);
  assert.ok(row && typeof row === 'object');
  const descendants = row as { pid: number; leaf: number };
  middlePid = descendants.pid;
  leafPid = descendants.leaf;
  assert.ok(Number.isInteger(middlePid) && Number.isInteger(leafPid));
  assert.ok(root.pid && unrelated.pid);
  const cleanup = await captureAcpDescendants(root.pid);
  assert.ok(alive(root.pid), 'capture must not terminate the server');
  assert.ok(alive(middlePid) && alive(leafPid), 'capture must not terminate descendants');
  root.send('session/cancel');
  await dead(root.pid);
  await delay(200); // The original server PID can no longer lead taskkill to its tree.
  assert.ok(alive(middlePid) && alive(leafPid), 'fixture must really orphan its descendants');
  const originalRoot = process.env.SystemRoot;
  process.env.SystemRoot = 'Z:\\missing-SECRET_TOKEN-private-root';
  try {
    await assert.rejects(cleanup(), { message: 'CodeBuddy ACP descendant cleanup failed (details omitted)' });
    assert.ok(alive(middlePid) && alive(leafPid), 'a failed cleanup must not claim surviving descendants are gone');
  } finally {
    if (originalRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalRoot;
  }
  await cleanup();
  await Promise.all([dead(middlePid), dead(leafPid)]);
  assert.ok(alive(unrelated.pid), 'cleanup must not kill another server or sibling process');
  await cleanup(); // An already-removed snapshot is safe to replay.
  assert.ok(alive(unrelated.pid));
});

test('Windows empty snapshot does not kill the root process', { skip: !windows, timeout: 15000 }, async t => {
  const root = fixture(LEAF);
  t.after(async () => { stop(root.pid); if (root.pid) await dead(root.pid); });
  await message(root);
  assert.ok(root.pid);
  const cleanup = await captureAcpDescendants(root.pid);
  await cleanup();
  assert.ok(alive(root.pid));
});

test('Windows rejects nonnumeric, out-of-range, and injected process IDs before spawning', { skip: !windows }, async () => {
  for (const pid of [0, -1, 1.5, NaN, Infinity, 0x1_0000_0000, '1; Write-Output SECRET_TOKEN' as unknown as number]) {
    await assert.rejects(captureAcpDescendants(pid), error => error instanceof RangeError && !error.message.includes('SECRET_TOKEN'));
  }
});

test('Windows helper spawn failures are reported without leaking executable paths or environment contents', { skip: !windows }, async () => {
  const original = process.env.SystemRoot;
  process.env.SystemRoot = 'Z:\\missing-SECRET_TOKEN-private-root';
  try {
    await assert.rejects(captureAcpDescendants(process.pid), error => error instanceof Error
      && error.message === 'CodeBuddy ACP descendant capture failed (details omitted)');
  } finally {
    if (original === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = original;
  }
});

test('POSIX descendant capture is a no-op because cancellation owns the process group', { skip: windows }, async () => {
  const cleanup = await captureAcpDescendants(process.pid);
  await cleanup();
  await cleanup();
  assert.ok(alive(process.pid));
});
