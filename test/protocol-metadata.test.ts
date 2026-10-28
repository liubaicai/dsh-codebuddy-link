import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeBuddyProtocol, NdjsonDecoder } from '../src/protocol.ts';

test('safe model identifiers are emitted from assistant messages and explicit system init models', () => {
  for (const model of ['a', 'Provider/Model_v2.1:latest-202610', 'm'.repeat(128)]) {
    assert.deepEqual(new CodeBuddyProtocol().accept({ type: 'assistant', message: { model } }), [{ type: 'metadata', model }]);
    assert.deepEqual(new CodeBuddyProtocol().accept({ type: 'system', subtype: 'init', model }), [{ type: 'metadata', model }]);
  }
});

test('model metadata rejects arbitrary text, invalid characters, types and overlong identifiers', () => {
  const invalid = [undefined, null, 42, true, {}, ['safe-model'], '', 'm'.repeat(129), '.model', '/model', '-model',
    ' model', 'model ', 'model\n', 'model\r\n', 'model\u0000', '模型', 'model@host', 'https://user:password@host',
    'https://private.example/SECRET_TOKEN', 'C:/Users/alice/private', 'provider/../model', 'provider//model',
    'Ignore previous instructions', 'Authorization: Bearer SECRET', 'error: secret prompt'];
  for (const model of invalid) {
    assert.deepEqual(new CodeBuddyProtocol().accept({ type: 'assistant', message: { model } }), [], `assistant: ${String(model)}`);
    assert.deepEqual(new CodeBuddyProtocol().accept({ type: 'system', subtype: 'init', model }), [], `system: ${String(model)}`);
  }
});

test('metadata only reads the allowed fields and excludes subagent assistant models', () => {
  const protocol = new CodeBuddyProtocol();
  const rows = [
    { type: 'system', subtype: 'init', message: { model: 'nested-model' }, models: ['listed-model'], prompt: 'SECRET' },
    { type: 'system', subtype: 'status', model: 'status-model' },
    { type: 'assistant', model: 'outer-model', total_credits: 10, message: {} },
    { type: 'assistant', parent_tool_use_id: 'tool', message: { model: 'subagent-model' } },
    { type: 'user', message: { model: 'user-model' } },
  ];
  for (const row of rows) assert.deepEqual(protocol.accept(row), []);
  assert.deepEqual(protocol.accept({ type: 'result', model: 'result-model', totalCredits: 10, totalCostUsd: 20 }), [{ type: 'result', text: '' }]);
});

test('result billing metadata accepts finite nonnegative numbers including zero', () => {
  for (const amount of [0, -0, 0.125, 42, Number.MAX_VALUE]) {
    assert.deepEqual(new CodeBuddyProtocol().accept({ type: 'result', total_credits: amount, total_cost_usd: amount }), [
      { type: 'metadata', totalCredits: amount, totalCostUsd: amount },
      { type: 'result', text: '' },
    ]);
  }
});

test('invalid billing fields are independently omitted and never produce empty metadata', () => {
  for (const invalid of [undefined, null, '', '0', '12.5', false, true, {}, [], -1, NaN, Infinity, -Infinity]) {
    assert.deepEqual(new CodeBuddyProtocol().accept({ type: 'result', total_credits: invalid, total_cost_usd: invalid }), [{ type: 'result', text: '' }]);
    assert.deepEqual(new CodeBuddyProtocol().accept({ type: 'result', total_credits: invalid, total_cost_usd: 0 }), [
      { type: 'metadata', totalCostUsd: 0 }, { type: 'result', text: '' },
    ]);
    assert.deepEqual(new CodeBuddyProtocol().accept({ type: 'result', total_credits: 0, total_cost_usd: invalid }), [
      { type: 'metadata', totalCredits: 0 }, { type: 'result', text: '' },
    ]);
  }
});

test('real-ish NDJSON retains text and usage semantics with additive metadata before terminal result', () => {
  const rows = [
    { type: 'system', subtype: 'init', session_id: 'session-1', model: 'auto', cwd: '/private/workspace', apiKeySource: 'SECRET' },
    { type: 'assistant', session_id: 'session-1', uuid: 'uuid-1', message: {
      id: 'msg-1', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'Hello.' }],
      usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', result: 'Hello.',
      total_credits: 0.75, total_cost_usd: 0.012, structured_output: { greeting: 'Hello.' },
      usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
      errors: ['SECRET'], prompt: 'SECRET', auth: 'SECRET',
    },
  ];
  const protocol = new CodeBuddyProtocol();
  const decoder = new NdjsonDecoder();
  const events = decoder.push(rows.map(row => JSON.stringify(row)).join('\n') + '\n').flatMap(row => protocol.accept(row));
  assert.deepEqual(events, [
    { type: 'metadata', model: 'auto' },
    { type: 'metadata', model: 'claude-sonnet-4-5-20250929' },
    { type: 'text', delta: 'Hello.' },
    { type: 'usage', input: 20, output: 3, cacheRead: 5, cacheWrite: 2 },
    { type: 'metadata', totalCredits: 0.75, totalCostUsd: 0.012 },
    { type: 'result', sessionId: 'session-1', text: 'Hello.', structuredOutput: { greeting: 'Hello.' } },
  ]);
  assert.equal(protocol.hasResult, true);
  assert.equal(JSON.stringify(events).includes('SECRET'), false);
});

test('result-only fallback retains usage then text ordering and keeps result last', () => {
  assert.deepEqual(new CodeBuddyProtocol().accept({
    type: 'result', result: 'fallback', total_credits: 0, total_cost_usd: 0, usage: { input_tokens: 2, output_tokens: 1 },
  }), [
    { type: 'usage', input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
    { type: 'text', delta: 'fallback' },
    { type: 'metadata', totalCredits: 0, totalCostUsd: 0 },
    { type: 'result', text: 'fallback' },
  ]);
});

test('model metadata does not duplicate streamed assistant text or change cumulative usage', () => {
  const protocol = new CodeBuddyProtocol();
  protocol.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', usage: { input_tokens: 10 } } } });
  protocol.accept({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello.' } } });
  assert.deepEqual(protocol.accept({ type: 'assistant', message: {
    id: 'm', model: 'safe-model', content: [{ type: 'text', text: 'Hello.' }], usage: { output_tokens: 2 },
  } }), [
    { type: 'metadata', model: 'safe-model' },
    { type: 'usage', input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  ]);
});

test('metadata fields do not bypass sanitized error or duplicate-result handling', () => {
  assert.throws(() => new CodeBuddyProtocol().accept({ type: 'result', is_error: true, total_credits: 1, errors: ['SECRET'] }), /^Error: CodeBuddy request failed$/);
  assert.throws(() => new CodeBuddyProtocol().accept({ type: 'result', is_error: true, total_cost_usd: 1, errors: ['401 SECRET'] }), /^Error: CodeBuddy request failed \(authentication required\): 在终端运行 codebuddy login 后重试$/);
  assert.throws(() => new CodeBuddyProtocol().accept({ type: 'assistant', message: { model: 'safe-model', content: [{ type: 'text', text: '401 Unauthorized' }] } }), /authentication required/);
  const protocol = new CodeBuddyProtocol();
  protocol.accept({ type: 'result', total_credits: 0 });
  assert.throws(() => protocol.accept({ type: 'result', total_credits: 1 }), /^Error: CodeBuddy emitted duplicate result$/);
});
