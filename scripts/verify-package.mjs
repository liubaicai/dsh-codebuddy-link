import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Git installs must not require TypeScript, devDependencies or build scripts.
// Exercise only published dist, with no network, credentials or installed CLI.
// CI separately rebuilds dist and rejects any uncommitted output changes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/client.js', 'dist/adapter.js', 'dist/config.js', 'dist/acp.js', 'dist/acp-usage.js', 'dist/acp-cleanup.js', 'dist/accounts.js', 'dist/account-service.js', 'dist/account-scheduler.js', 'dist/prompt.js', 'dist/response.js', 'dist/json.js', 'dist/dsml.js', 'assets/workbuddy.webp', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json']) {
  assert.ok(existsSync(resolve(root, file)), `Missing published file: ${file}. Run npm ci && npm run build before packing.`);
}
assert.equal(pkg.main, './dist/index.js');
// Import the actual package entry too: leaf imports alone miss peer/import errors.
const entry = await import('../dist/index.js');
assert.equal(entry.name, pkg.name);
assert.equal(typeof entry.apply, 'function');
const { CodeBuddyAdapter } = await import('../dist/adapter.js');
const { resolveConfig } = await import('../dist/config.js');
const { runCodeBuddyAcp } = await import('../dist/acp.js');
const collect = async source => {
  const events = [];
  for await (const event of source) events.push(event);
  return events;
};

const finalText = '{"text":"opaque 中文😀","toolCalls":[{"name":"dsh_only_tool","arguments":{}}]}\n<｜DSML｜tool_calls>not executable</｜DSML｜tool_calls>';
const schemaSentinel = 'DSH_ONLY_SCHEMA_SENTINEL';
const privateInput = 'NATIVE_INPUT_MUST_NOT_REPLAY';
const privateOutput = 'NATIVE_OUTPUT_MUST_NOT_REPLAY';
const options = {
  provider: 'codebuddy', model: 'default', system: 'Respect the package smoke task.', sessionId: 'host-session',
  messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Package smoke task' }] }],
  tools: [{ name: 'dsh_only_tool', description: schemaSentinel, parameters: {} }],
};
const config = resolveConfig({ workspaceRoot: root, dangerouslySkipPermissions: true }, {});
let adapterCalls = 0;
const runner = async function* (request) {
  adapterCalls++;
  assert.equal(request.tools, 'default');
  assert.equal(request.dangerouslySkipPermissions, true);
  assert.equal(request.systemPrompt, undefined);
  assert.equal(request.jsonSchema, undefined);
  assert.equal(request.cwd, root);
  assert.ok(request.appendSystemPrompt.includes(options.system));
  assert.ok(request.appendSystemPrompt.includes('native CodeBuddy tools'));
  assert.ok(request.prompt.includes('Package smoke task'));
  assert.ok(!JSON.stringify(request).includes(schemaSentinel));
  assert.ok(!JSON.stringify(request).includes('dsh_only_tool'));
  assert.ok(!request.prompt.includes('Reply using NDJSON'));
  yield { type: 'text', delta: 'Native progress only' };
  yield { type: 'tool-start', id: 'native-1', name: 'Read', input: privateInput };
  yield { type: 'tool-end', id: 'native-1', name: 'Read', output: privateOutput, isError: false };
  yield { type: 'result', sessionId: 'native-session', text: finalText, structuredOutput: { toolCalls: [{ name: 'dsh_only_tool' }] } };
};
const output = await collect(new CodeBuddyAdapter(config, runner).stream(options));
assert.equal(adapterCalls, 1);
assert.deepEqual(output.filter(event => event.type === 'text-delta').map(event => event.text), [finalText]);
assert.ok(output.some(event => event.type === 'reasoning-delta' && event.text.includes('Read')));
assert.ok(!output.some(event => event.type === 'tool-call-delta' || event.blockType === 'tool-call' || event.block?.type === 'tool-call'));
assert.ok(!JSON.stringify(output).includes(privateInput));
assert.ok(!JSON.stringify(output).includes(privateOutput));
assert.equal(output.filter(event => event.type === 'finish').length, 1);
assert.equal(output.at(-1).reason.kind, 'stop');

let housekeepingCalls = 0;
const housekeeping = async function* (request) {
  housekeepingCalls++;
  assert.equal(request.tools, '');
  assert.equal(request.dangerouslySkipPermissions, undefined);
  assert.equal(request.permissionMode, 'dontAsk');
  assert.equal(request.appendSystemPrompt, undefined);
  assert.equal(request.systemPrompt, options.system);
  assert.equal(request.jsonSchema, undefined);
  assert.ok(!JSON.stringify(request).includes(schemaSentinel));
  assert.ok(!JSON.stringify(request).includes('dsh_only_tool'));
  assert.ok(!request.prompt.includes('Reply using NDJSON'));
  yield { type: 'result', text: 'Package smoke title' };
};
const title = await collect(new CodeBuddyAdapter(config, housekeeping).stream({ ...options, purpose: 'session-title' }));
assert.equal(housekeepingCalls, 1);
assert.deepEqual(title.filter(event => event.type === 'text-delta').map(event => event.text), ['Package smoke title']);
assert.equal(title.at(-1).reason.kind, 'stop');

// A tiny ACP server, not the real CLI. It only writes fixture traces and speaks
// JSON-RPC; native-tool notifications below are inert test data, never actions.
// Keep it alive after end_turn so the published transport must clean it up.
const fakeCli = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync('server.pid', String(process.pid));
writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
const send = row => process.stdout.write(JSON.stringify(row) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const update = row => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fresh-session', update: row } });
const text = (messageId, value) => update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: value } });
let promptId;
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  appendFileSync('wire.ndjson', line + '\n');
  if (row.method === 'initialize') return reply(row.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  if (row.method === 'session/new') return reply(row.id, { sessionId: 'fresh-session' });
  if (row.method === 'session/prompt') {
    promptId = row.id;
    // The bridge must reject host-side execution, not replay this request.
    return send({ jsonrpc: '2.0', id: 'unsupported-host-request', method: 'terminal/create', params: { command: 'MUST_NOT_EXECUTE' } });
  }
  if (row.id !== 'unsupported-host-request') return;
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'native-1', title: 'Read', status: 'pending', rawInput: { fixture: true } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'native-1', status: 'completed', rawOutput: 'fixture only' });
  text('progress', 'intermediate');
  text('final', '中文😀');
  text('final', ' done');
  reply(promptId, { stopReason: 'end_turn' });
});
// Last-resort bound if a regressed transport forgets cleanup; never spawn tools.
setTimeout(() => process.exit(2), 60000).unref();
`;
const cwd = await mkdtemp(join(tmpdir(), 'codebuddy package smoke '));
try {
  const bin = join(cwd, 'fake acp.mjs');
  await writeFile(bin, fakeCli);
  const prompt = 'Complete history\nuser and assistant';
  let spawned = 0;
  const events = await collect(runCodeBuddyAcp({ bin, cwd, prompt, sessionId: 'must-not-resume', permissionMode: 'dontAsk', timeoutMs: 15000, onSpawn: () => { spawned++; } }));
  assert.equal(spawned, 1);
  assert.deepEqual(events, [
    { type: 'reasoning', delta: 'thinking' },
    { type: 'tool-start', id: 'native-1', name: 'Read', input: { fixture: true } },
    { type: 'tool-end', id: 'native-1', name: 'Read', output: 'fixture only', isError: false },
    { type: 'text', delta: 'intermediate' },
    { type: 'text', delta: '中文😀' },
    { type: 'text', delta: ' done' },
    { type: 'result', sessionId: 'fresh-session', text: 'intermediate中文😀 done' },
  ]);
  const rows = (await readFile(join(cwd, 'wire.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } },
    { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'fresh-session', prompt: [{ type: 'text', text: prompt }] } },
    { jsonrpc: '2.0', id: 'unsupported-host-request', error: { code: -32601, message: 'Method not found' } },
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'argv.json'), 'utf8')), [
    '--acp', '--acp-transport', 'stdio', '--tools', 'default', '--no-session-persistence', '--permission-mode', 'dontAsk',
  ]);
  const pid = Number(await readFile(join(cwd, 'server.pid'), 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Fake ACP process survived transport completion');
} finally {
  // Windows process/antivirus handles may take a moment to release the fixture.
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`Verified prebuilt package ${pkg.name}@${pkg.version} (entry, adapter, offline ACP)`);
