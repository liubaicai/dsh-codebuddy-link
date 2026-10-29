import { spawn } from 'node:child_process';
import { AcpUsage } from "./acp-usage.js";
import { captureAcpDescendants } from "./acp-cleanup.js";
import { isModelIdentifier } from "./metadata.js";
import { NdjsonDecoder } from "./protocol.js";
import { childEnv, killTree, resolveCodeBuddyBin } from "./runner.js";
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validId = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
const protocolError = () => new Error('Invalid CodeBuddy ACP protocol message (content omitted)');
const abortError = () => Object.assign(new Error('CodeBuddy ACP request aborted'), { name: 'AbortError' });
const DEFAULT_TIMEOUT = 10 * 60 * 1000;
const CANCEL_GRACE_MS = 200;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/**
 * Native tools remain entirely inside CodeBuddy. ACP notifications are display
 * events, never tool requests to execute or replay in the host. Each invocation
 * creates a fresh process/session; request.prompt contains the complete history.
 */
export async function* runCodeBuddyAcp(request) {
    if (request.signal?.aborted)
        throw abortError();
    if (typeof request.prompt !== 'string' || typeof request.cwd !== 'string' || !request.cwd)
        throw new TypeError('prompt and cwd are required');
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
        throw new RangeError('timeoutMs must be a positive finite timer duration');
    if (request.permissionMode && !['dontAsk', 'plan', 'acceptEdits'].includes(request.permissionMode))
        throw new TypeError('Unsupported permissionMode');
    if (request.dangerouslySkipPermissions !== undefined && typeof request.dangerouslySkipPermissions !== 'boolean')
        throw new TypeError('dangerouslySkipPermissions must be boolean');
    if (request.jsonSchema !== undefined)
        throw new TypeError('JSON schema output is not supported by CodeBuddy ACP');
    const executable = await resolveCodeBuddyBin(request.bin, request.cwd);
    if (request.signal?.aborted)
        throw abortError();
    const args = [...executable.args, '--acp', '--acp-transport', 'stdio', '--tools', 'default', '--no-session-persistence'];
    if (request.dangerouslySkipPermissions)
        args.push('--dangerously-skip-permissions');
    else
        args.push('--permission-mode', request.permissionMode ?? 'dontAsk');
    for (const [flag, value] of [['--system-prompt', request.systemPrompt], ['--append-system-prompt', request.appendSystemPrompt], ['--model', request.model], ['--effort', request.effort]]) {
        if (value !== undefined)
            args.push(flag, value);
    }
    const child = spawn(executable.command, args, { cwd: request.cwd, env: childEnv(request.authToken), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new NdjsonDecoder(MAX_FRAME_BYTES);
    const pending = new Map();
    const queue = [];
    const tools = new Map();
    let queueBytes = 0;
    let outputBytes = 0;
    let output = '';
    let messageId;
    let setupSessionId;
    const usage = new AcpUsage();
    let nextId = 0;
    let sessionId;
    let failure;
    let finished = false;
    let promptResponded = false;
    let closed = false;
    let resolveClosed;
    const didClose = new Promise(resolve => { resolveClosed = resolve; });
    let stopping = false;
    let wake;
    let termination;
    let cleanupFailure;
    const notify = () => { const resolve = wake; wake = undefined; resolve?.(); };
    const rejectPending = (error) => {
        for (const entry of pending.values())
            entry.reject(error);
        pending.clear();
    };
    const send = (message) => {
        if (closed || child.stdin.destroyed || !child.stdin.writable)
            throw new Error('CodeBuddy ACP connection closed');
        const frame = JSON.stringify(message) + '\n';
        const bytes = Buffer.byteLength(frame);
        if (bytes > MAX_FRAME_BYTES || child.stdin.writableLength + bytes > MAX_BUFFER_BYTES)
            throw new Error('CodeBuddy ACP request exceeds buffer limit');
        child.stdin.write(frame);
    };
    const terminate = (cancel) => termination ??= (async () => {
        stopping = true;
        clearTimeout(timer);
        let cleanup;
        // Snapshot identities BEFORE the agent can exit in response to cancel.
        // If capture fails, still force cleanup below, but do not claim success.
        if (child.pid) {
            try {
                cleanup = await captureAcpDescendants(child.pid);
            }
            catch {
                cleanupFailure = new Error('CodeBuddy ACP descendant capture failed; cleanup could not be verified');
            }
        }
        if (cancel && sessionId && !closed) {
            try {
                send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
            }
            catch { /* Broken pipe: kill below. */ }
            // Keep draining during this short grace period, but never execute requests.
            await new Promise(resolve => setTimeout(resolve, CANCEL_GRACE_MS));
        }
        try {
            await killTree(child);
        }
        catch {
            cleanupFailure = new Error('CodeBuddy ACP process cleanup failed');
        }
        try {
            await cleanup?.();
        }
        catch {
            cleanupFailure = new Error('CodeBuddy ACP descendant cleanup failed; native work may still be running');
        }
        // killTree on POSIX signals synchronously; wait for stdio/process closure
        // before publishing a result, but do not let a broken child block forever.
        if (!closed)
            await new Promise(resolve => {
                const timer = setTimeout(resolve, 1000);
                void didClose.then(() => { clearTimeout(timer); resolve(); });
            });
        if (!closed)
            cleanupFailure = new Error('CodeBuddy ACP process did not close after cleanup');
    })();
    const fail = (error) => {
        if (failure)
            return;
        failure = error;
        rejectPending(error);
        notify();
        void terminate(true);
    };
    const push = (event) => {
        const bytes = Buffer.byteLength(JSON.stringify(event));
        if (queueBytes + bytes > MAX_BUFFER_BYTES)
            throw new Error('CodeBuddy ACP event buffer exceeds limit');
        queue.push({ event, bytes });
        queueBytes += bytes;
        notify();
    };
    const rpc = (method, params) => new Promise((resolve, reject) => {
        if (failure || stopping) {
            reject(failure ?? new Error('CodeBuddy ACP connection closed'));
            return;
        }
        const id = ++nextId;
        pending.set(id, { method, resolve, reject });
        try {
            send({ jsonrpc: '2.0', id, method, params });
        }
        catch {
            pending.delete(id);
            reject(new Error('Unable to send CodeBuddy ACP request'));
        }
    });
    const update = (params) => {
        if (typeof params.sessionId !== 'string' || !params.sessionId || params.sessionId.length > 512 || !object(params.update))
            throw protocolError();
        const row = params.update;
        if (typeof row.sessionUpdate !== 'string')
            throw protocolError();
        // CodeBuddy emits initial config metadata BEFORE answering session/new.
        // Admit only that non-executing setup notification and bind its ID later.
        if (!sessionId) {
            if (![...pending.values()].some(entry => entry.method === 'session/new') || row.sessionUpdate !== 'config_option_update')
                throw protocolError();
            if (setupSessionId && setupSessionId !== params.sessionId)
                throw protocolError();
            setupSessionId = params.sessionId;
            return;
        }
        if (params.sessionId !== sessionId)
            throw protocolError();
        for (const event of usage.accept(row))
            push(event);
        if (row.sessionUpdate === 'agent_message_chunk' || row.sessionUpdate === 'agent_thought_chunk') {
            if (!object(row.content) || typeof row.content.type !== 'string')
                throw protocolError();
            if (row.content.type !== 'text')
                return;
            if (typeof row.content.text !== 'string')
                throw protocolError();
            const delta = row.content.text;
            if (!delta)
                return;
            const type = row.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning';
            if (type === 'text') {
                const meta = object(row._meta) ? row._meta : {};
                const id = row.messageId ?? meta['codebuddy.ai/messageId'];
                if (id !== undefined && typeof id !== 'string')
                    throw protocolError();
                if (typeof id === 'string' && id && id !== messageId) {
                    output = '';
                    messageId = id;
                }
                outputBytes += Buffer.byteLength(delta);
                if (outputBytes > MAX_BUFFER_BYTES)
                    throw new Error('CodeBuddy ACP response exceeds limit');
                output += delta;
            }
            push({ type, delta });
        }
        else if (row.sessionUpdate === 'tool_call' || row.sessionUpdate === 'tool_call_update') {
            if (typeof row.toolCallId !== 'string' || !row.toolCallId)
                throw protocolError();
            if (row.title !== undefined && typeof row.title !== 'string')
                throw protocolError();
            if (row.kind !== undefined && typeof row.kind !== 'string')
                throw protocolError();
            if (row.status !== undefined && (typeof row.status !== 'string' || !['pending', 'in_progress', 'completed', 'failed'].includes(row.status)))
                throw protocolError();
            let tool = tools.get(row.toolCallId);
            if (!tool) {
                if (tools.size >= 10000)
                    throw new Error('CodeBuddy ACP tool notification limit exceeded');
                tool = { name: row.title || row.kind || 'CodeBuddy tool', ended: false };
                tools.set(row.toolCallId, tool);
                push({ type: 'tool-start', id: row.toolCallId, name: tool.name, ...(owns(row, 'rawInput') ? { input: row.rawInput } : {}) });
            }
            if (!tool.ended && (row.status === 'completed' || row.status === 'failed')) {
                tool.ended = true;
                push({ type: 'tool-end', id: row.toolCallId, name: tool.name, ...(owns(row, 'rawOutput') ? { output: row.rawOutput } : owns(row, 'content') ? { output: row.content } : {}), isError: row.status === 'failed' });
            }
        }
        // Context occupancy is ignored; only verified CodeBuddy billing extensions
        // are handled by AcpUsage above.
    };
    const accept = (value) => {
        if (!object(value) || value.jsonrpc !== '2.0')
            throw protocolError();
        if (owns(value, 'method')) {
            if (typeof value.method !== 'string' || !value.method || owns(value, 'result') || owns(value, 'error'))
                throw protocolError();
            if (owns(value, 'params') && !object(value.params) && !Array.isArray(value.params))
                throw protocolError();
            if (['session/update', 'session/request_permission'].includes(value.method) && !object(value.params))
                throw protocolError();
            const params = (value.params ?? {});
            if (owns(value, 'id')) {
                if (!validId(value.id))
                    throw protocolError();
                if (value.method === 'session/request_permission') {
                    if (!sessionId || params.sessionId !== sessionId || !object(params.toolCall) || !Array.isArray(params.options))
                        throw protocolError();
                    send({ jsonrpc: '2.0', id: value.id, result: { outcome: { outcome: 'cancelled' } } });
                    fail(new Error('CodeBuddy ACP permission request cancelled: this non-interactive bridge never approves residual permission prompts, including HIGH/CRITICAL actions. Review and run the action in an interactive CodeBuddy session.'));
                }
                else {
                    send({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Method not found' } });
                }
            }
            else if (value.method === 'session/update') {
                if (promptResponded)
                    throw protocolError();
                if (!finished && !stopping)
                    update(params);
            }
            else if (value.method === 'session/request_permission') {
                throw protocolError();
            }
            return;
        }
        if (!validId(value.id) || owns(value, 'params') || owns(value, 'result') === owns(value, 'error'))
            throw protocolError();
        const entry = pending.get(value.id);
        if (!entry)
            throw protocolError();
        if (owns(value, 'error')) {
            if (!object(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== 'string')
                throw protocolError();
            pending.delete(value.id);
            // ACP standard authentication-required error; never classify message text.
            const cause = new Error(value.error.code === -32000 ? 'CodeBuddy account requires authorization' : 'CodeBuddy ACP request failed (server error details omitted)');
            if (value.error.code === -32000)
                cause.name = 'CodeBuddyAuthError';
            entry.reject(cause);
        }
        else {
            // A session response and its first notification can share one stdout
            // chunk; record the ID synchronously, before the driver's await resumes.
            if (entry.method === 'session/new') {
                if (!object(value.result) || typeof value.result.sessionId !== 'string' || !value.result.sessionId || value.result.sessionId.length > 512)
                    throw protocolError();
                if (setupSessionId && setupSessionId !== value.result.sessionId)
                    throw protocolError();
                sessionId = value.result.sessionId;
            }
            if (entry.method === 'session/prompt')
                promptResponded = true;
            pending.delete(value.id);
            entry.resolve(value.result);
        }
    };
    const onData = (chunk) => {
        if (failure || stopping)
            return;
        try {
            for (const value of decoder.push(chunk))
                accept(value);
        }
        catch {
            fail(new Error('Invalid or oversized CodeBuddy ACP stream (content omitted)'));
        }
    };
    const onEnd = () => {
        if (failure || stopping)
            return;
        try {
            for (const value of decoder.finish())
                accept(value);
            if (!promptResponded)
                fail(new Error('CodeBuddy ACP stream ended before prompt completion'));
        }
        catch {
            fail(new Error('Invalid or oversized CodeBuddy ACP stream (content omitted)'));
        }
    };
    const onProcessError = () => fail(new Error('Unable to start or communicate with CodeBuddy ACP process'));
    const onPipeError = () => { if (!stopping)
        fail(new Error('CodeBuddy ACP connection failed')); };
    const onClose = (code) => {
        closed = true;
        resolveClosed();
        if (!stopping && (!finished || code !== 0))
            fail(new Error('CodeBuddy ACP process exited before successful completion (diagnostics omitted)'));
        notify();
    };
    const onSpawn = () => {
        try {
            request.onSpawn?.();
        }
        catch {
            fail(new Error('CodeBuddy ACP spawn callback failed'));
        }
    };
    const onAbort = () => fail(abortError());
    const timer = setTimeout(() => fail(Object.assign(new Error(`CodeBuddy ACP request timed out after ${timeoutMs}ms`), { name: 'TimeoutError' })), timeoutMs);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('spawn', onSpawn);
    child.on('error', onProcessError);
    child.once('close', onClose);
    child.stdin.on('error', onPipeError);
    child.stdout.on('error', onPipeError);
    child.stderr.on('error', onPipeError);
    child.stdout.on('data', onData);
    child.stdout.once('end', onEnd);
    // stderr is intentionally discarded, not attached to errors: it can contain
    // authentication tokens and private backend URLs. resume also prevents stalls.
    child.stderr.resume();
    if (request.signal?.aborted)
        onAbort();
    const driver = (async () => {
        try {
            const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
            if (!object(init) || init.protocolVersion !== 1 || !object(init.agentCapabilities))
                throw protocolError();
            if (failure)
                throw failure;
            const session = await rpc('session/new', { cwd: request.cwd, mcpServers: [] });
            if (!object(session) || typeof session.sessionId !== 'string' || !session.sessionId)
                throw protocolError();
            sessionId = session.sessionId;
            const models = object(session.models) ? session.models : {};
            if (typeof models.currentModelId === 'string' && request.model && models.currentModelId !== request.model)
                throw new Error('CodeBuddy ACP selected a different model than requested');
            if (isModelIdentifier(models.currentModelId))
                push({ type: 'metadata', model: models.currentModelId });
            if (failure)
                throw failure;
            const result = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: request.prompt }] });
            if (!object(result) || typeof result.stopReason !== 'string')
                throw protocolError();
            const resultMeta = object(result._meta) ? result._meta : {};
            const outcome = resultMeta['codebuddy.ai/outcome'];
            if (outcome !== undefined && outcome !== 'SUCCESS')
                throw new Error('CodeBuddy ACP reported an unsuccessful outcome');
            if (result.stopReason !== 'end_turn') {
                const reasons = { cancelled: 'cancelled', refusal: 'refused', max_tokens: 'stopped at the token limit', max_turn_requests: 'stopped at the turn limit' };
                const reason = owns(reasons, result.stopReason) ? reasons[result.stopReason] : 'stopped without end_turn';
                throw new Error(`CodeBuddy ACP request ${reason}`);
            }
            finished = true;
            notify();
        }
        catch (error) {
            fail(error instanceof Error ? error : new Error('CodeBuddy ACP request failed'));
        }
    })();
    let finalResult;
    try {
        while (true) {
            if (failure)
                throw failure;
            const next = queue.shift();
            if (next) {
                queueBytes -= next.bytes;
                yield next.event;
                continue;
            }
            if (finished)
                break;
            await new Promise(resolve => { wake = resolve; });
        }
        // The prompt RPC is the completion boundary; the ACP server normally stays
        // alive awaiting another prompt. Stop it before publishing the final result.
        await terminate(false);
        if (failure)
            throw failure;
        finalResult = { type: 'result', sessionId, text: output };
    }
    finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        rejectPending(failure ?? new Error('CodeBuddy ACP consumer closed'));
        await terminate(!finished);
        await driver;
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.removeListener('spawn', onSpawn);
        child.removeListener('close', onClose);
        child.stdout.removeListener('data', onData);
        child.stdout.removeListener('end', onEnd);
        // Error listeners remain until the stream destroy callbacks run, preventing
        // late EPIPE from becoming an unhandled error. once-close then removes them.
        const removeErrors = () => {
            child.removeListener('error', onProcessError);
            child.stdin.removeListener('error', onPipeError);
            child.stdout.removeListener('error', onPipeError);
            child.stderr.removeListener('error', onPipeError);
        };
        if (closed)
            removeErrors();
        else
            child.once('close', removeErrors);
        queue.length = 0;
        tools.clear();
        wake = undefined;
        if (cleanupFailure)
            throw cleanupFailure;
    }
    // Nothing remains live while the consumer holds the final yielded event.
    if (finalResult)
        yield finalResult;
}
//# sourceMappingURL=acp.js.map