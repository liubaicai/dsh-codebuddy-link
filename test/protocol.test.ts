import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CodeBuddyProtocol, NdjsonDecoder } from '../src/protocol.ts';

test('NDJSON preserves split UTF8, CRLF, blank lines and flushes final line', () => {
  const decoder = new NdjsonDecoder();
  const bytes = Buffer.from(' {"text":"中文😀"}\r\n\n{"last":true}');
  const results: unknown[] = [];
  for (const byte of bytes) results.push(...decoder.push(Buffer.from([byte])));
  results.push(...decoder.finish());
  assert.deepEqual(results, [{ text: '中文😀' }, { last: true }]);
});
test('NDJSON rejects malformed and oversized lines without content disclosure', () => {
  assert.throws(() => new NdjsonDecoder().push('SECRET\n'), /Invalid CodeBuddy NDJSON/);
  assert.throws(() => new NdjsonDecoder(4).push('12345'), /exceeds limit/);
});
test('partial messages avoid duplicate final text and aggregate usage snapshots', () => {
  const p = new CodeBuddyProtocol();
  const stream = (event: unknown) => p.accept({ type: 'stream_event', event });
  stream({ type: 'message_start', message: { id: 'one', usage: { input_tokens: 10, cache_read_input_tokens: 4 } } });
  assert.deepEqual(stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'think' } }), [{ type: 'reasoning', delta: 'think' }]);
  assert.deepEqual(stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }), [{ type: 'text', delta: 'hello' }]);
  assert.deepEqual(stream({ type: 'message_delta', usage: { output_tokens: 2 } }), [{ type: 'usage', input: 10, output: 2, cacheRead: 4, cacheWrite: 0 }]);
  assert.deepEqual(p.accept({ type: 'assistant', message: { id: 'one', content: [{ type: 'text', text: 'hello' }, { type: 'thinking', thinking: 'think' }] } }), []);
  assert.deepEqual(p.accept({ type: 'assistant', message: { id: 'two', content: [{ type: 'text', text: '!' }], usage: { input_tokens: 6, output_tokens: 1 } } }), [{ type: 'text', delta: '!' }, { type: 'usage', input: 16, output: 3, cacheRead: 4, cacheWrite: 0 }]);
  assert.deepEqual(p.accept({ type: 'result', session_id: 's', result: 'hello!', structured_output: { x: 1 } }), [{ type: 'result', sessionId: 's', text: 'hello!', structuredOutput: { x: 1 } }]);
});
test('tool start/end normalize and deduplicate; subagent text is excluded', () => {
  const p = new CodeBuddyProtocol();
  const tool = { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } };
  assert.deepEqual(p.accept({ type: 'assistant', message: { id: 'm', content: [tool] } }), [{ type: 'tool-start', id: 't1', name: 'Read', input: { path: 'a' } }]);
  assert.deepEqual(p.accept({ type: 'assistant', message: { id: 'm', content: [tool] } }), []);
  assert.deepEqual(p.accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }), [{ type: 'tool-end', id: 't1', name: 'Read', output: 'ok', isError: false }]);
  assert.deepEqual(p.accept({ type: 'assistant', parent_tool_use_id: 't1', message: { content: [{ type: 'text', text: 'hidden' }] } }), []);
});
test('sanitized real CodeBuddy 2.177.1 authentication capture is detected despite exit zero', async () => {
  const fixture = await readFile(new URL('./fixtures/codebuddy-2.177.1-auth-error.ndjson', import.meta.url));
  const decoder = new NdjsonDecoder();
  const protocol = new CodeBuddyProtocol();
  assert.throws(() => { for (const row of decoder.push(fixture)) protocol.accept(row); }, /authentication required/);
});
test('result-only fallback and authentication errors', () => {
  assert.deepEqual(new CodeBuddyProtocol().accept({ type: 'result', result: 'fallback' }), [{ type: 'text', delta: 'fallback' }, { type: 'result', text: 'fallback' }]);
  assert.throws(() => new CodeBuddyProtocol().accept({ type: 'result', is_error: true, errors: ['401 secret'] }), /authentication required/);
});
test('result text alone signals authentication with a login hint', () => {
  // CLI 2.177.1 emits "401 Unauthorized" as the assistant/result text with errors sometimes empty.
  assert.throws(() => new CodeBuddyProtocol().accept({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], result: '401 Unauthorized' }), /authentication required.*codebuddy login/);
  assert.throws(() => new CodeBuddyProtocol().accept({ type: 'result', is_error: true, errors: [], result: 'boom' }), /^Error: CodeBuddy request failed$/);
});
test('assistant message echoing a bare HTTP status fails fast instead of hanging', () => {
  // --json-schema mode: CLI emits the 401 as the whole assistant message, then no result row and no exit.
  const auth = { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: '401 Unauthorized' }] } };
  assert.throws(() => new CodeBuddyProtocol().accept(auth), /authentication required.*codebuddy login/);
  assert.throws(() => new CodeBuddyProtocol().accept({ type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: '429 Too Many Requests' }] } }), /^Error: CodeBuddy request failed: 429 Too Many Requests$/);
  // A normal reply merely mentioning a status code must keep streaming as text.
  const normal = new CodeBuddyProtocol().accept({ type: 'assistant', message: { id: 'a3', content: [{ type: 'text', text: 'HTTP 500 errors usually mean the server had a problem; here is what to check…' }] } });
  assert.ok(normal.some(e => e.type === 'text' && e.delta.includes('HTTP 500')));
  const twoBlocks = new CodeBuddyProtocol().accept({ type: 'assistant', message: { id: 'a4', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '401 Unauthorized' }] } });
  assert.ok(twoBlocks.some(e => e.type === 'text'));
});
