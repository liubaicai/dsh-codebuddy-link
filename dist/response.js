import { parseDsml } from "./dsml.js";
import { strictJson } from "./json.js";
const MAX_DEPTH = 32;
const MAX_DOCUMENTS = 64;
const MAX_CALLS = 32;
const own = (o, key) => Object.hasOwn(o, key);
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (detail) => { throw new Error(`Invalid CodeBuddy response envelope: ${detail}`); };
function keys(o, allowed) {
    if (Object.keys(o).some(k => !allowed.includes(k)))
        fail('unknown or conflicting fields');
}
function one(o, names) {
    const present = names.filter(k => own(o, k));
    if (present.length > 1)
        fail(`conflicting aliases (${present.join(', ')})`);
    return present[0];
}
/** Anchored JSON/NDJSON plus whole JSON fences (including one fence per part).
 * Never look for executable JSON embedded in natural-language explanations. */
function documents(input, allowFence = true) {
    const result = [];
    let i = 0;
    while (i < input.length) {
        if (/\s/.test(input[i])) {
            i++;
            continue;
        }
        if (input.startsWith('```', i)) {
            if (!allowFence)
                fail('nested JSON fences');
            const opening = /^```(?:json|jsonc|jsonl|ndjson)?[ \t]*\r?\n/i.exec(input.slice(i));
            if (!opening)
                fail('unsupported or incomplete JSON fence');
            const start = i + opening[0].length;
            const ending = /^[ \t]*```[ \t]*(?=\r?$)/m.exec(input.slice(start));
            if (!ending)
                fail('unclosed JSON fence');
            const inner = input.slice(start, start + ending.index);
            // Opening fences inside JSON strings are opaque. At document boundaries
            // nested fences are disallowed by the explicit transport-depth guard.
            result.push(...documents(inner, false));
            i = start + ending.index + ending[0].length;
        }
        else {
            const start = i;
            const stack = [];
            let inString = false, escaped = false;
            if (!['{', '[', '"'].includes(input[i]))
                fail('unexpected text outside structured response');
            const quoted = input[i] === '"';
            for (; i < input.length; i++) {
                const c = input[i];
                if (inString) {
                    if (escaped)
                        escaped = false;
                    else if (c === '\\')
                        escaped = true;
                    else if (c === '"') {
                        inString = false;
                        if (quoted && !stack.length) {
                            i++;
                            break;
                        }
                    }
                    continue;
                }
                if (c === '"')
                    inString = true;
                else if (c === '{' || c === '[') {
                    stack.push(c);
                    if (stack.length > MAX_DEPTH)
                        fail('JSON nesting limit exceeded');
                }
                else if (c === '}' || c === ']') {
                    if (stack.pop() !== (c === '}' ? '{' : '['))
                        fail('mismatched JSON delimiters');
                    if (!stack.length) {
                        i++;
                        break;
                    }
                }
            }
            if (inString || stack.length)
                fail('incomplete JSON document');
            result.push(strictJson(input.slice(start, i)));
        }
        if (result.length > MAX_DOCUMENTS)
            fail('too many response documents');
    }
    if (!result.length)
        fail('empty structured response');
    return result;
}
class Normalizer {
    texts = [];
    calls = [];
    ids = new Set();
    nodes = 0;
    refused = false;
    names;
    constructor(names) { this.names = names; }
    text(value, nullable = false) {
        if (nullable && value === null)
            return;
        if (typeof value !== 'string')
            fail('text must be a string');
        if (value)
            this.texts.push(value);
    }
    call(value, depth = 0) {
        if (depth > MAX_DEPTH || ++this.nodes > 256)
            fail('tool call nesting/item limit exceeded');
        if (!object(value))
            fail('tool call must be an object');
        const o = value;
        // Responses API has both an output-item id and a separate call_id.
        for (const key of ['id', 'call_id'])
            if (own(o, key) && (typeof o[key] !== 'string' || !o[key]))
                fail('invalid tool call id');
        const id = o.call_id ?? o.id;
        if (typeof id === 'string') {
            if (this.ids.has(id))
                fail('duplicate tool call id');
            this.ids.add(id);
        }
        if (own(o, 'function')) {
            keys(o, ['id', 'type', 'function']);
            if (own(o, 'type') && o.type !== 'function')
                fail('unsupported tool call type');
            this.call(o.function, depth + 1);
            return;
        }
        if (own(o, 'functionCall')) {
            keys(o, ['functionCall', 'thoughtSignature']);
            if (o.thoughtSignature !== undefined && typeof o.thoughtSignature !== 'string')
                fail('invalid thought signature');
            this.call(o.functionCall, depth + 1);
            return;
        }
        keys(o, ['name', 'arguments', 'args', 'input', 'parameters', 'id', 'call_id', 'type', 'status']);
        if (o.status !== undefined && o.status !== 'completed')
            fail('incomplete function call');
        const type = o.type;
        if (type !== undefined && !['tool_use', 'tool-call', 'function_call', 'function'].includes(type))
            fail('unsupported tool call type');
        if (typeof o.name !== 'string' || !this.names.has(o.name))
            fail('unknown tool name');
        const argumentKey = one(o, ['arguments', 'args', 'input', 'parameters']);
        if (!argumentKey)
            fail('missing tool arguments');
        const source = o[argumentKey];
        const args = typeof source === 'string' ? strictJson(source) : source;
        if (!object(args))
            fail('tool arguments must be a JSON object');
        // In-memory structuredOutput must be JSON data too: no toJSON hooks,
        // undefined, non-finite numbers, sparse arrays, cycles or class instances.
        const checkData = (v, depth) => {
            if (depth > MAX_DEPTH)
                fail('argument nesting limit exceeded');
            if (v === null || typeof v === 'string' || typeof v === 'boolean')
                return;
            if (typeof v === 'number' && Number.isFinite(v))
                return;
            if (Array.isArray(v)) {
                if (Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1)
                    fail('non-data argument array');
                for (let n = 0; n < v.length; n++) {
                    const descriptor = Object.getOwnPropertyDescriptor(v, String(n));
                    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
                        fail('sparse or accessor argument array');
                    checkData(descriptor.value, depth + 1);
                }
                return;
            }
            if (object(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
                for (const property of Reflect.ownKeys(v)) {
                    if (typeof property !== 'string')
                        fail('non-JSON argument key');
                    const descriptor = Object.getOwnPropertyDescriptor(v, property);
                    if (!own(descriptor, 'value') || !descriptor.enumerable)
                        fail('non-data argument property');
                    checkData(descriptor.value, depth + 1);
                }
                return;
            }
            fail('non-JSON argument value');
        };
        checkData(args, 0);
        let encoded;
        try {
            encoded = typeof source === 'string' ? source : JSON.stringify(args);
            if (!encoded)
                fail('non-JSON tool arguments');
            strictJson(encoded);
        }
        catch {
            return fail('tool arguments must be a JSON object');
        }
        if (this.calls.length >= MAX_CALLS)
            fail('at most 32 tool calls');
        this.calls.push({ name: o.name, arguments: encoded });
    }
    callList(value) {
        if (value === null)
            return; // OpenAI nullable no-call field.
        if (!Array.isArray(value))
            fail('tool call list must be an array');
        for (const call of value)
            this.call(call);
    }
    blocks(value, depth) {
        if (typeof value === 'string') {
            this.text(value);
            return;
        }
        if (value === null)
            return;
        if (!Array.isArray(value))
            fail('content must be text or content blocks');
        for (const block of value)
            this.visit(block, depth + 1);
    }
    visit(value, depth = 0) {
        if (depth > MAX_DEPTH || ++this.nodes > 256)
            fail('response nesting/item limit exceeded');
        if (Array.isArray(value)) {
            if (!value.length)
                fail('empty top-level response array');
            for (const part of value)
                this.visit(part, depth + 1);
            return;
        }
        if (!object(value))
            fail('expected a response object');
        const o = value;
        // Explicit SDK wrappers only, never recursive searches through arbitrary data.
        if (own(o, 'output')) {
            keys(o, ['output', 'id', 'object', 'created_at', 'completed_at', 'model', 'status', 'error', 'incomplete_details', 'usage', 'parallel_tool_calls', 'output_text', 'background', 'instructions', 'max_output_tokens', 'max_tool_calls', 'metadata', 'previous_response_id', 'prompt_cache_key', 'prompt_cache_retention', 'reasoning', 'safety_identifier', 'service_tier', 'store', 'temperature', 'text', 'tool_choice', 'tools', 'top_logprobs', 'top_p', 'truncation', 'user']);
            if (o.status !== undefined && o.status !== 'completed')
                fail('incomplete or blocked response');
            if (o.error != null || o.incomplete_details != null)
                fail('failed or incomplete response');
            if (!Array.isArray(o.output) || !o.output.length)
                fail('empty response output');
            this.visit(o.output, depth + 1);
            return;
        }
        if (own(o, 'choices')) {
            keys(o, ['choices', 'id', 'object', 'created', 'model', 'usage', 'system_fingerprint', 'service_tier']);
            if (!Array.isArray(o.choices) || o.choices.length !== 1 || !object(o.choices[0]))
                fail('expected exactly one completion choice');
            const choice = o.choices[0];
            keys(choice, ['index', 'message', 'finish_reason', 'logprobs']);
            if (choice.index !== undefined && choice.index !== 0)
                fail('unexpected choice index');
            if (choice.finish_reason && !['stop', 'tool_calls', 'function_call'].includes(choice.finish_reason))
                fail('incomplete or blocked completion');
            this.visit(choice.message, depth + 1);
            return;
        }
        if (own(o, 'candidates')) {
            keys(o, ['candidates', 'usageMetadata', 'modelVersion', 'responseId']);
            if (!Array.isArray(o.candidates) || o.candidates.length !== 1 || !object(o.candidates[0]))
                fail('expected exactly one Gemini candidate');
            const candidate = o.candidates[0];
            keys(candidate, ['content', 'finishReason', 'index', 'safetyRatings', 'citationMetadata', 'avgLogprobs']);
            if (candidate.finishReason !== undefined && candidate.finishReason !== 'STOP')
                fail('incomplete or blocked candidate');
            if (candidate.index !== undefined && candidate.index !== 0)
                fail('unexpected candidate index');
            this.visit(candidate.content, depth + 1);
            return;
        }
        if (object(o.content) && own(o.content, 'parts')) {
            keys(o, ['content']);
            this.visit(o.content, depth + 1);
            return;
        }
        if (own(o, 'message')) {
            keys(o, ['message']);
            this.visit(o.message, depth + 1);
            return;
        }
        if (own(o, 'role') && o.role !== 'assistant' && o.role !== 'model')
            fail('non-assistant response role');
        if (o.type === 'refusal') {
            keys(o, ['type', 'refusal']);
            this.text(o.refusal);
            this.refused = true;
            return;
        }
        if (o.type === 'reasoning') {
            keys(o, ['type', 'id', 'summary', 'content', 'encrypted_content', 'status']);
            if (o.status !== undefined && o.status !== 'completed')
                fail('incomplete reasoning item');
            for (const field of ['summary', 'content'])
                if (o[field] !== undefined) {
                    if (!Array.isArray(o[field]))
                        fail('invalid reasoning content');
                    for (const item of o[field]) {
                        if (!object(item))
                            fail('invalid reasoning block');
                        keys(item, ['type', 'text']);
                        if (!['summary_text', 'reasoning_text'].includes(item.type) || typeof item.text !== 'string')
                            fail('invalid reasoning text');
                    }
                }
            if (o.encrypted_content != null && typeof o.encrypted_content !== 'string')
                fail('invalid encrypted reasoning');
            return;
        }
        if (o.type === 'thinking') {
            keys(o, ['type', 'thinking', 'signature']);
            if (typeof o.thinking !== 'string' || (o.signature !== undefined && typeof o.signature !== 'string'))
                fail('invalid thinking block');
            return; // Internal reasoning is deliberately not surfaced as final text.
        }
        if (o.type === 'redacted_thinking') {
            keys(o, ['type', 'data']);
            if (typeof o.data !== 'string')
                fail('invalid redacted thinking');
            return;
        }
        if (own(o, 'thought') || (own(o, 'thoughtSignature') && own(o, 'text'))) {
            keys(o, ['text', 'thought', 'thoughtSignature']);
            if (typeof o.text !== 'string' || (o.thought !== undefined && typeof o.thought !== 'boolean') || (o.thoughtSignature !== undefined && typeof o.thoughtSignature !== 'string'))
                fail('invalid Gemini thought part');
            if (!o.thought)
                this.text(o.text);
            return;
        }
        if (own(o, 'function') || own(o, 'functionCall') || own(o, 'name') || ['tool_use', 'tool-call', 'function_call'].includes(o.type)) {
            this.call(o);
            return;
        }
        if (o.type === 'text' || o.type === 'output_text') {
            keys(o, ['type', 'text', 'annotations']);
            this.text(o.text);
            return;
        }
        if (own(o, 'parts')) {
            keys(o, ['role', 'parts']);
            this.blocks(o.parts, depth);
            return;
        }
        const refused = own(o, 'refusal') && o.refusal !== null && o.refusal !== '';
        const beforeCalls = this.calls.length;
        if (refused) {
            this.refused = true;
            this.text(o.refusal);
        }
        keys(o, ['text', 'content', 'toolCalls', 'tool_calls', 'function_call', 'role', 'refusal', 'id', 'type', 'model', 'usage', 'stop_reason', 'stop_sequence', 'status']);
        if (o.status !== undefined && o.status !== 'completed')
            fail('incomplete message');
        if (o.type !== undefined && o.type !== 'message')
            fail('unsupported content block type');
        if (o.stop_reason && !['end_turn', 'tool_use', 'stop_sequence'].includes(o.stop_reason))
            fail('incomplete or blocked message');
        const textKey = one(o, ['text', 'content']);
        const callsKey = one(o, ['toolCalls', 'tool_calls', 'function_call']);
        if (!textKey && !callsKey && !o.refusal)
            fail('missing text or tool calls');
        if (textKey === 'text')
            this.text(o.text, true);
        if (textKey === 'content')
            this.blocks(o.content, depth);
        if (callsKey && this.calls.length !== beforeCalls)
            fail('competing content and tool-call channels');
        if (callsKey === 'function_call') {
            if (o.function_call !== null)
                this.call(o.function_call);
        }
        else if (callsKey)
            this.callList(o[callsKey]);
        if (refused && this.calls.length !== beforeCalls)
            fail('refusal combined with tool calls');
    }
    result() {
        if (this.refused && this.calls.length)
            fail('refusal combined with tool calls');
        return { text: this.texts.join('\n\n'), toolCalls: this.calls };
    }
}
/** Broad wire-format compatibility is deliberately anchored at response level.
 * Explanations/code examples are text, not a source of executable fragments. */
export function parseResponse(value, tools) {
    const normalizer = new Normalizer(new Set(tools.map(t => t.name)));
    if (typeof value !== 'string') {
        normalizer.visit(value);
        return normalizer.result();
    }
    const raw = value;
    let input = raw.trim();
    if (!input)
        fail('empty response');
    if (input.startsWith('<｜｜DSML｜｜')) {
        normalizer.visit(parseDsml(input));
        return normalizer.result();
    }
    // Hermes/Qwen complete JSON tool-call tags. No prose or arbitrary XML parsing.
    if (/^<tool_call>/.test(input)) {
        let count = 0;
        while (input) {
            if (!input.startsWith('<tool_call>'))
                fail('unexpected data outside tool_call tags');
            let end = -1, quoted = false, escaped = false;
            for (let i = '<tool_call>'.length; i < input.length; i++) {
                const c = input[i];
                if (quoted) {
                    if (escaped)
                        escaped = false;
                    else if (c === '\\')
                        escaped = true;
                    else if (c === '"')
                        quoted = false;
                }
                else if (c === '"')
                    quoted = true;
                else if (input.startsWith('</tool_call>', i)) {
                    end = i;
                    break;
                }
            }
            if (end < 0 || ++count > MAX_DOCUMENTS)
                fail('incomplete or excessive tool_call tags');
            const body = input.slice('<tool_call>'.length, end);
            normalizer.visit(strictJson(body));
            input = input.slice(end + '</tool_call>'.length).trim();
        }
        return normalizer.result();
    }
    if (/^[\[{"]/.test(input) || /^```(?:json|jsonc|jsonl|ndjson)?[ \t]*\r?\n/i.test(input)) {
        let docs = documents(input);
        // A single extra JSON encoding is common in CLI wrappers. Decode once only.
        if (docs.length === 1 && typeof docs[0] === 'string') {
            const decoded = docs[0].trim();
            if (!/^[\[{]/.test(decoded))
                fail('JSON string is not a response object');
            docs = documents(decoded);
        }
        for (const doc of docs)
            normalizer.visit(doc);
        return normalizer.result();
    }
    if (/^<\/?(?:tool_call|function_call|function_calls|invoke)\b|^<\|(?:tool|function)/i.test(input))
        fail('unsupported tool serialization');
    // A real DSML document mixed into prose remains ambiguous; never execute it.
    if (input.includes('<｜｜DSML｜｜'))
        fail('DSML must be a standalone document');
    return { text: raw, toolCalls: [] };
}
//# sourceMappingURL=response.js.map