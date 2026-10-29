import { spawn } from 'node:child_process';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isRequestModelIdentifier } from "./model-id.js";
import { CodeBuddyProtocol, NdjsonDecoder } from "./protocol.js";
const STDERR_LIMIT = 16 * 1024;
const DEFAULT_TIMEOUT = 10 * 60 * 1000;
/** Resolve npm's Windows launchers without ever invoking cmd.exe or PowerShell. */
export async function resolveCodeBuddyBin(bin = 'codebuddy', cwd = process.cwd()) {
    const pinned = isAbsolute(bin) || /[\\/]/.test(bin);
    const candidates = pinned ? [resolve(cwd, bin)]
        : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path.replace(/^"|"$/g, ''), bin));
    const extensions = process.platform === 'win32' ? ['', '.cmd', '.exe', '.ps1', '.bat'] : [''];
    const javascript = (path) => ['.js', '.mjs', '.cjs'].includes(extname(path).toLowerCase());
    const unsupported = () => new Error('Unsupported CodeBuddy launcher; provide the actual CLI JavaScript file');
    for (const candidate of candidates) {
        for (const extension of pinned || extname(candidate) ? [''] : extensions) {
            const path = candidate + extension;
            try {
                await access(path, process.platform === 'win32' || javascript(path) ? constants.F_OK : constants.X_OK);
            }
            catch (error) {
                if (pinned && error.code !== 'ENOENT')
                    throw error;
                continue;
            }
            try {
                const resolved = await realpath(path);
                if (!(await stat(resolved)).isFile())
                    throw unsupported();
                const ext = extname(resolved).toLowerCase();
                if (javascript(resolved))
                    return { command: process.execPath, args: [resolved] };
                if (['.cmd', '.bat', '.ps1'].includes(ext) || (process.platform === 'win32' && !ext)) {
                    const source = await readFile(resolved, 'utf8');
                    // Only npm-style basedir-relative node_modules targets are unwrapped.
                    // Even a recognized shim must point to a real Node entry, not a shell or directory.
                    const match = source.match(/(?:%~?dp0%?|%dp0%|\$basedir)[\\/]([^"'\r\n]*?node_modules[\\/][^"'\r\n]+)/i);
                    if (match) {
                        const target = await realpath(resolve(dirname(resolved), match[1].replace(/[\\/]/g, '/')));
                        await access(target, constants.R_OK);
                        if (!(await stat(target)).isFile())
                            throw unsupported();
                        if (!javascript(target) && (extname(target) || !/^#![^\r\n]*\bnode\b/.test(await readFile(target, 'utf8'))))
                            throw unsupported();
                        return { command: process.execPath, args: [target] };
                    }
                    if (!ext && /^#![^\r\n]*\bnode\b/.test(source))
                        return { command: process.execPath, args: [resolved] };
                    throw unsupported();
                }
                if (process.platform === 'win32' && ext !== '.exe' && ext !== '.com')
                    throw unsupported();
                return { command: resolved, args: [] };
            }
            catch (error) {
                // PATH is discovery: an unusable shell shim must not hide its .cmd/.exe
                // sibling or later installs. An explicit path is pinned and must fail closed.
                if (pinned)
                    throw error;
            }
        }
    }
    throw new Error('CodeBuddy executable not found; install codebuddy or configure bin');
}
function abortError() { const error = new Error('CodeBuddy request aborted'); error.name = 'AbortError'; return error; }
/**
 * Children must run as plain Node. When the DSH host is an Electron app,
 * process.execPath is the GUI binary: spawning it with a script argument would
 * start a second GUI instance that never answers and hangs the request until
 * timeout. ELECTRON_RUN_AS_NODE makes an Electron binary behave as plain Node;
 * a real Node executable simply ignores the variable.
 */
export function childEnv(authToken) {
    // The CLI's getAuthenticationAttributesSync checks CODEBUDDY_AUTH_TOKEN before its own
    // stored login, so a token here authenticates even an unsigned-in or expired CLI install.
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    // Authentication belongs to the selected plugin account, never the launching shell.
    // Remove casing variants too: Windows environment variable names are case-insensitive.
    for (const key of Object.keys(env))
        if (key.toUpperCase() === 'CODEBUDDY_AUTH_TOKEN')
            delete env[key];
    if (authToken)
        env.CODEBUDDY_AUTH_TOKEN = authToken;
    return env;
}
export async function killTree(child) {
    if (!child.pid)
        return;
    if (process.platform === 'win32') {
        await new Promise(resolveKill => {
            const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
            const timer = setTimeout(() => { killer.kill(); child.kill('SIGKILL'); resolveKill(); }, 3000);
            killer.once('error', () => { clearTimeout(timer); child.kill('SIGKILL'); resolveKill(); });
            killer.once('close', () => { clearTimeout(timer); resolveKill(); });
        });
    }
    else {
        try {
            process.kill(-child.pid, 'SIGKILL');
        }
        catch {
            try {
                child.kill('SIGKILL');
            }
            catch { /* Already exited. */ }
        }
    }
}
/** One fresh CLI process per call; the complete conversation belongs in prompt. */
export async function* runCodeBuddy(request) {
    if (request.signal?.aborted)
        throw abortError();
    if (typeof request.prompt !== 'string' || !request.cwd)
        throw new TypeError('prompt and cwd are required');
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
        throw new RangeError('timeoutMs must be a positive finite timer duration');
    if (request.permissionMode && !['dontAsk', 'plan', 'acceptEdits'].includes(request.permissionMode))
        throw new TypeError('Unsupported permissionMode');
    if (request.model !== undefined && !isRequestModelIdentifier(request.model))
        throw new TypeError('Invalid model id');
    const executable = await resolveCodeBuddyBin(request.bin, request.cwd);
    if (request.signal?.aborted)
        throw abortError();
    if (request.dangerouslySkipPermissions !== undefined && typeof request.dangerouslySkipPermissions !== 'boolean')
        throw new TypeError('dangerouslySkipPermissions must be boolean');
    const args = [...executable.args, '--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--input-format', 'text', '--tools', request.tools ?? '', '--no-session-persistence'];
    // Never combine a restrictive permission mode with the explicit bypass flag.
    if (request.dangerouslySkipPermissions)
        args.push('--dangerously-skip-permissions');
    else
        args.push('--permission-mode', request.permissionMode ?? 'dontAsk');
    for (const [flag, value] of [['--system-prompt', request.systemPrompt], ['--append-system-prompt', request.appendSystemPrompt], ['--model', request.model], ['--effort', request.effort]]) {
        if (value !== undefined)
            args.push(flag, value);
    }
    if (request.jsonSchema !== undefined)
        args.push('--json-schema', JSON.stringify(request.jsonSchema));
    const child = spawn(executable.command, args, { cwd: request.cwd, env: childEnv(request.authToken), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let failure;
    let closed = false;
    let stderr = '';
    const stderrDecoder = new StringDecoder('utf8');
    let termination;
    const terminate = () => termination ??= killTree(child);
    const fail = (error) => { failure ??= error; void terminate(); child.stdout.destroy(error); };
    const onAbort = () => fail(abortError());
    const timer = setTimeout(() => { const error = new Error(`CodeBuddy request timed out after ${timeoutMs}ms`); error.name = 'TimeoutError'; fail(error); }, timeoutMs);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const exit = new Promise(resolveExit => {
        child.once('spawn', () => { request.onSpawn?.(); });
        child.once('error', error => { failure ??= error; });
        child.once('close', (code, signal) => { closed = true; resolveExit({ code, signal }); });
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + stderrDecoder.write(chunk)).slice(-STDERR_LIMIT); });
    child.stderr.on('end', () => { stderr = (stderr + stderrDecoder.end()).slice(-STDERR_LIMIT); });
    // EPIPE is expected when the child rejects options before reading stdin.
    child.stdin.on('error', error => { if (error.code !== 'EPIPE')
        fail(error); });
    child.stdin.end(request.prompt);
    if (request.signal?.aborted)
        onAbort();
    const decoder = new NdjsonDecoder();
    const protocol = new CodeBuddyProtocol();
    let result;
    try {
        for await (const chunk of child.stdout) {
            if (failure)
                throw failure;
            for (const value of decoder.push(chunk))
                for (const event of protocol.accept(value)) {
                    if (event.type === 'result')
                        result = event;
                    else
                        yield event;
                }
        }
        for (const value of decoder.finish())
            for (const event of protocol.accept(value)) {
                if (event.type === 'result')
                    result = event;
                else
                    yield event;
            }
        const status = await exit;
        if (failure)
            throw failure;
        // Captured stderr is bounded but never exposed: it may contain login secrets.
        if (status.code !== 0)
            throw new Error(`CodeBuddy exited with ${status.code === null ? `signal ${status.signal}` : `code ${status.code}`}${stderr ? ' (stderr omitted)' : ''}`);
        if (!protocol.hasResult || !result)
            throw new Error('CodeBuddy exited without a result');
        yield result;
    }
    catch (error) {
        throw failure ?? error;
    }
    finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        if (!closed || termination)
            await terminate();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
    }
}
//# sourceMappingURL=runner.js.map