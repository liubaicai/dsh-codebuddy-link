import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionMetadata } from '../src/acp-messages.ts';
import { runCodeBuddyAcp } from '../src/acp.ts';

test('ACP rejects invalid request model IDs before resolving or starting a process', async () => {
  for (const model of ['m'.repeat(257), 'provider/name', 'https://host/model', '../model', 'C:model', 'model\n']) {
    const iterator = runCodeBuddyAcp({prompt:'fixture',cwd:process.cwd(),bin:'missing-fixture-cli',model});
    await assert.rejects(iterator.next(), /Invalid CodeBuddy request model id/);
  }
});

test('late metadata allowlist validates ACP shapes without treating execution as metadata', () => {
  for (const row of [
    { sessionUpdate: 'session_info_update' },
    { sessionUpdate: 'session_info_update', title: null, updatedAt: '2026-10-29T00:00:00Z', _meta: {} },
    { sessionUpdate: 'current_mode_update', currentModeId: 'default' },
    { sessionUpdate: 'config_option_update', configOptions: [] },
    { sessionUpdate: 'config_option_update', configOptions: [{ id: 'toggle', name: 'Toggle', type: 'boolean', currentValue: true }] },
    { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'a', options: [{ group: 'models', name: 'Models', options: [{ value: 'a', name: 'A' }] }] }] },
    { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help', description: 'Help', input: null }] },
    { sessionUpdate: 'usage_update', used: 12, size: 100, cost: { amount: 0.3, currency: 'USD' }, _meta: { opaque: { command: 'never replay' } } },
  ]) assert.equal(isSessionMetadata(row), true, JSON.stringify(row));
  for (const row of [
    { sessionUpdate: 'session_info_update', title: 12 },
    { sessionUpdate: 'session_info_update', updatedAt: {} },
    { sessionUpdate: 'session_info_update', _meta: [] },
    { sessionUpdate: 'current_mode_update' },
    { sessionUpdate: 'config_option_update', configOptions: null },
    { sessionUpdate: 'config_option_update', configOptions: [{ id: 'a', name: 'A', type: 'select', currentValue: 'a', options: [{}] }] },
    { sessionUpdate: 'config_option_update', configOptions: [{ id: 'a', name: 'A', type: 'boolean', currentValue: 'true' }] },
    { sessionUpdate: 'available_commands_update', availableCommands: [{}] },
    { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help', description: 'Help', input: {} }] },
    { sessionUpdate: 'usage_update', used: -1, size: 100 },
    { sessionUpdate: 'usage_update', used: 12, size: 100, cost: { amount: Infinity, currency: 'USD' } },
    ...['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'unknown'].map(sessionUpdate => ({ sessionUpdate })),
  ]) assert.equal(isSessionMetadata(row), false, JSON.stringify(row));
});
