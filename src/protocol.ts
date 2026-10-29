import { StringDecoder } from 'node:string_decoder';
import { isModelIdentifier } from './metadata.ts';

export type BridgeEvent =
  | { type: 'text' | 'reasoning'; delta: string }
  | { type: 'usage'; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { type: 'metadata'; model?: string; totalCredits?: number; totalCostUsd?: number }
  | { type: 'tool-start'; id: string; name: string; input?: unknown }
  | { type: 'tool-end'; id: string; name?: string; output?: unknown; isError?: boolean }
  | { type: 'result'; sessionId?: string; text: string; structuredOutput?: unknown; partialSuccess?: boolean };

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
type Usage = Extract<BridgeEvent, { type: 'usage' }>;

/** Incremental UTF-8 NDJSON framing. Final unterminated lines are valid. */
export class NdjsonDecoder {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private readonly maxLineBytes: number;
  constructor(maxLineBytes = 8 * 1024 * 1024) { this.maxLineBytes = maxLineBytes; }
  push(chunk: Buffer | string): unknown[] {
    return this.consume(typeof chunk === 'string' ? chunk : this.decoder.write(chunk), false);
  }
  finish(): unknown[] { return this.consume(this.decoder.end(), true); }
  private consume(chunk: string, final: boolean): unknown[] {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = final ? '' : lines.pop() ?? '';
    if (Buffer.byteLength(this.pending) > this.maxLineBytes) throw new Error('CodeBuddy NDJSON line exceeds limit');
    const values: unknown[] = [];
    for (const line of lines) {
      if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error('CodeBuddy NDJSON line exceeds limit');
      if (!line.trim()) continue;
      try { values.push(JSON.parse(line)); }
      catch { throw new Error('Invalid CodeBuddy NDJSON (line content omitted)'); }
    }
    return values;
  }
}

/** Stateful Claude-compatible CodeBuddy stream-json adapter. Usage events are cumulative snapshots. */
export class CodeBuddyProtocol {
  private sessionId?: string;
  private activeId = '';
  private sequence = 0;
  private streamed = new Map<string, { text: string; reasoning: string }>();
  private usages = new Map<string, Usage>();
  private tools = new Map<string, string>();
  private endedTools = new Set<string>();
  private assistantIds = new Set<string>();
  private output = '';
  private lastUsage = '';
  private done = false;
  get hasResult(): boolean { return this.done; }

  accept(value: unknown): BridgeEvent[] {
    const row = record(value);
    const events: BridgeEvent[] = [];
    if (typeof row.session_id === 'string') this.sessionId = row.session_id;
    if (row.type === 'error') throw new Error('CodeBuddy reported a protocol error');
    if (row.type === 'system' && row.subtype === 'init') {
      this.emitMetadata({ model: row.model }, events);
    } else if (row.type === 'stream_event') {
      // Subagent streams are not the main assistant response.
      if (row.parent_tool_use_id) return events;
      const event = record(row.event);
      if (event.type === 'message_start') {
        const message = record(event.message);
        this.activeId = text(message.id) || `stream-${++this.sequence}`;
        this.streamed.set(this.activeId, { text: '', reasoning: '' });
        this.updateUsage(this.activeId, message.usage, events);
      } else if (event.type === 'content_block_start') {
        const block = record(event.content_block);
        if (block.type === 'tool_use') this.startTool(block, events);
        if (block.type === 'text') this.delta('text', text(block.text), events);
        if (block.type === 'thinking') this.delta('reasoning', text(block.thinking), events);
      } else if (event.type === 'content_block_delta') {
        const delta = record(event.delta);
        if (delta.type === 'text_delta') this.delta('text', text(delta.text), events);
        if (delta.type === 'thinking_delta' || delta.type === 'reasoning_delta') this.delta('reasoning', text(delta.thinking) || text(delta.reasoning), events);
      } else if (event.type === 'message_delta') {
        this.updateUsage(this.activeId, event.usage, events);
      }
    } else if (row.type === 'assistant' && !row.parent_tool_use_id) {
      const message = record(row.message);
      this.emitMetadata({ model: message.model }, events);
      const id = text(message.id) || this.activeId || text(row.uuid) || `assistant-${++this.sequence}`;
      if (!this.assistantIds.has(id)) {
        this.assistantIds.add(id);
        const blocks = Array.isArray(message.content) ? message.content.map(record) : [];
        this.rejectEchoedHttpError(blocks);
        const streamed = this.streamed.get(id);
        for (const kind of ['text', 'reasoning'] as const) {
          const full = blocks.filter(b => b.type === (kind === 'text' ? 'text' : 'thinking')).map(b => text(b[kind === 'text' ? 'text' : 'thinking'])).join('');
          const prior = streamed?.[kind] ?? '';
          const rest = full.startsWith(prior) ? full.slice(prior.length) : prior ? '' : full;
          if (rest) { events.push({ type: kind, delta: rest }); if (kind === 'text') this.output += rest; }
        }
        for (const block of blocks) if (block.type === 'tool_use') this.startTool(block, events);
      }
      this.updateUsage(id, message.usage, events);
    } else if (row.type === 'user') {
      const message = record(row.message);
      for (const item of Array.isArray(message.content) ? message.content : []) {
        const block = record(item);
        const id = text(block.tool_use_id);
        if (block.type === 'tool_result' && id && !this.endedTools.has(id)) {
          this.endedTools.add(id);
          events.push({ type: 'tool-end', id, name: this.tools.get(id), output: block.content, isError: block.is_error === true });
        }
      }
    } else if (row.type === 'result') {
      if (this.done) throw new Error('CodeBuddy emitted duplicate result');
      this.done = true;
      // Do not relay arbitrary CLI errors: they can contain credentials or proxy URLs.
      if (row.is_error === true || (typeof row.subtype === 'string' && row.subtype.startsWith('error'))) {
        // The result text mirrors the error surface (e.g. "401 Unauthorized") and is API-generated, not secret.
        const authLike = /auth|401|unauthor/i.test(`${JSON.stringify(row.errors ?? [])} ${typeof row.result === 'string' ? row.result : ''}`);
        throw new Error(authLike
          ? 'CodeBuddy request failed (authentication required): 在终端运行 codebuddy login 后重试'
          : 'CodeBuddy request failed');
      }
      if (row.usage !== undefined) this.emitUsage(this.parseUsage(row.usage), events);
      const resultText = typeof row.result === 'string' ? row.result : this.output;
      if (!this.output && resultText) events.push({ type: 'text', delta: resultText });
      this.emitMetadata({ totalCredits: row.total_credits, totalCostUsd: row.total_cost_usd }, events);
      events.push({ type: 'result', ...(this.sessionId ? { sessionId: this.sessionId } : {}), text: resultText, ...(row.structured_output !== undefined ? { structuredOutput: row.structured_output } : {}) });
    }
    return events;
  }
  /**
   * When the API call fails, the CLI relays the status line (e.g. "401
   * Unauthorized") as the entire assistant message. In --json-schema mode the
   * CLI then never emits a result row and never exits, so the request would
   * hang until the timeout. A bare HTTP status line is never legitimate model
   * output: fail fast instead of streaming it as text.
   */
  private rejectEchoedHttpError(blocks: RecordValue[]): void {
    if (blocks.length !== 1 || blocks[0]!.type !== 'text') return;
    const message = text(blocks[0]!.text).trim();
    if (message.length > 80 || !/^[45]\d{2}( [A-Za-z .,'/-]+)?$/.test(message)) return;
    throw new Error(/401|unauth/i.test(message)
      ? 'CodeBuddy request failed (authentication required): 在终端运行 codebuddy login 后重试'
      : `CodeBuddy request failed: ${message}`);
  }
  private delta(kind: 'text' | 'reasoning', delta: string, events: BridgeEvent[]): void {
    if (!delta) return;
    if (!this.activeId) this.activeId = `stream-${++this.sequence}`;
    const state = this.streamed.get(this.activeId) ?? { text: '', reasoning: '' };
    state[kind] += delta;
    this.streamed.set(this.activeId, state);
    if (kind === 'text') this.output += delta;
    events.push({ type: kind, delta });
  }
  private startTool(block: RecordValue, events: BridgeEvent[]): void {
    const id = text(block.id), name = text(block.name);
    if (!id || this.tools.has(id)) return;
    this.tools.set(id, name);
    events.push({ type: 'tool-start', id, name, input: block.input });
  }
  private emitMetadata(raw: RecordValue, events: BridgeEvent[]): void {
    const metadata: Extract<BridgeEvent, { type: 'metadata' }> = { type: 'metadata' };
    // Compare the full match too: JavaScript's $ can match before a final newline.
    if (isModelIdentifier(raw.model)) metadata.model = raw.model;
    for (const key of ['totalCredits', 'totalCostUsd'] as const) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metadata[key] = value;
    }
    if (metadata.model !== undefined || metadata.totalCredits !== undefined || metadata.totalCostUsd !== undefined) events.push(metadata);
  }
  private parseUsage(value: unknown): Usage {
    const usage = record(value);
    return { type: 'usage', input: count(usage.input_tokens), output: count(usage.output_tokens), cacheRead: count(usage.cache_read_input_tokens), cacheWrite: count(usage.cache_creation_input_tokens) };
  }
  private updateUsage(id: string, value: unknown, events: BridgeEvent[]): void {
    if (!value || !id) return;
    const raw = record(value), next = this.parseUsage(value), previous = this.usages.get(id);
    if (previous) {
      if (raw.input_tokens === undefined) next.input = previous.input;
      if (raw.output_tokens === undefined) next.output = previous.output;
      if (raw.cache_read_input_tokens === undefined) next.cacheRead = previous.cacheRead;
      if (raw.cache_creation_input_tokens === undefined) next.cacheWrite = previous.cacheWrite;
    }
    this.usages.set(id, next);
    const total: Usage = { type: 'usage', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const usage of this.usages.values()) for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) total[key] += usage[key];
    this.emitUsage(total, events);
  }
  private emitUsage(usage: Usage, events: BridgeEvent[]): void {
    const serialized = JSON.stringify(usage);
    if (serialized !== this.lastUsage) { this.lastUsage = serialized; events.push(usage); }
  }
}
