import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { settingsPath } from "./settings.js";
const ORIGIN = 'https://www.codebuddy.cn';
const LIMIT = 64 * 1024;
const TTL = 600_000;
const INTERVAL = 2;
const REQUEST_TIMEOUT = 15_000;
const invalid = () => new Error('Unsupported CodeBuddy personal-account credentials');
const failed = () => new Error('CodeBuddy authorization failed or timed out');
const expired = () => new Error('CodeBuddy authorization flow is no longer active');
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function personal(value) {
    for (const key of ['enterpriseId', 'enterprise_id', 'enterpriseName', 'enterprise_name', 'tenantId', 'tenant_id']) {
        if (value[key] !== undefined && value[key] !== null && value[key] !== '')
            throw invalid();
    }
    for (const key of ['domain', 'baseUrl', 'base_url']) {
        if (value[key] !== undefined && value[key] !== '' && value[key] !== 'www.codebuddy.cn' && value[key] !== ORIGIN)
            throw invalid();
    }
    if (value.tokenType !== undefined && value.tokenType !== 'Bearer')
        throw invalid();
}
function token(value) {
    if (value.accessToken !== undefined && value.access_token !== undefined && value.accessToken !== value.access_token)
        throw invalid();
    const result = value.accessToken ?? value.access_token;
    if (typeof result !== 'string' || result.length > 16384 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(result) || /^(encrypted|protected|enc)[.:_-]/i.test(result))
        throw invalid();
    return result;
}
/** Strict JSON only: no bare tokens, no credential discovery and no refresh tokens retained. */
export function parseCredential(input) {
    try {
        if (typeof input === 'string') {
            if (Buffer.byteLength(input) > LIMIT)
                throw invalid();
            input = JSON.parse(input);
        }
        const root = object(input);
        if (!root)
            throw invalid();
        personal(root);
        const nested = 'auth' in root || 'account' in root;
        const auth = nested ? object(root.auth) : root;
        const account = nested ? object(root.account) : root;
        if (!auth || !account)
            throw invalid();
        if (nested && ('accessToken' in root || 'access_token' in root || 'uid' in root))
            throw invalid();
        personal(auth);
        personal(account);
        const accessToken = token(auth), uid = account.uid;
        if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(uid))
            throw invalid();
        return { accessToken, uid };
    }
    catch {
        throw invalid();
    }
}
export class AuthStore {
    path;
    generation = 0;
    get revision() { return this.generation; }
    constructor(path = join(dirname(settingsPath()), 'credentials.json')) { this.path = path; }
    async read() {
        let fd;
        try {
            if (lstatSync(this.path).isSymbolicLink())
                throw invalid();
            fd = openSync(this.path, 'r');
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > LIMIT)
                throw invalid();
            const bytes = Buffer.alloc(LIMIT + 1);
            const length = readSync(fd, bytes, 0, bytes.length, 0);
            if (length > LIMIT)
                throw invalid();
            return parseCredential(bytes.subarray(0, length).toString('utf8'));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return undefined;
            throw new Error('Cannot read CodeBuddy credentials');
        }
        finally {
            if (fd !== undefined)
                closeSync(fd);
        }
    }
    async status() {
        try {
            return { configured: (await this.read()) !== undefined };
        }
        catch {
            return { configured: false };
        }
    }
    async import(value) {
        const credential = parseCredential(value);
        this.generation++;
        const tmp = this.path + '.' + randomBytes(16).toString('hex') + '.tmp';
        try {
            const parent = dirname(this.path);
            mkdirSync(parent, { recursive: true, mode: 0o700 });
            if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())
                throw invalid();
            chmodSync(parent, 0o700);
            // Synchronous atomic commit intentionally prevents cancel/clear interleaving with rename.
            writeFileSync(tmp, JSON.stringify(credential) + '\n', { flag: 'wx', mode: 0o600 });
            chmodSync(tmp, 0o600);
            renameSync(tmp, this.path);
        }
        catch {
            throw new Error('Cannot save CodeBuddy credentials');
        }
        finally {
            try {
                unlinkSync(tmp);
            }
            catch { /* no temporary secret left after successful rename */ }
        }
    }
    async clear() {
        this.generation++;
        try {
            unlinkSync(this.path);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw new Error('Cannot clear CodeBuddy credentials');
        }
    }
}
async function boundedJSON(response) {
    if (!response.body)
        throw failed();
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done)
                break;
            size += part.value.byteLength;
            if (size > LIMIT)
                throw failed();
            chunks.push(part.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    finally {
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
function success(payload) { return payload.code === 0 || payload.code === 200; }
function verification(value, state) {
    if (value === undefined || value === '')
        return `${ORIGIN}/login?state=${encodeURIComponent(state)}`;
    if (typeof value !== 'string' || value.length > 8192)
        throw failed();
    try {
        const url = new URL(value);
        if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password)
            throw failed();
        return url.href;
    }
    catch {
        throw failed();
    }
}
export class AuthManager {
    fetcher;
    now;
    flow;
    generation = 0;
    starting;
    store;
    constructor(store, options = {}) {
        this.store = store;
        this.fetcher = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
    }
    cancelAll() {
        this.generation++;
        this.starting?.abort();
        this.starting = undefined;
        this.flow?.controller.abort();
        this.flow = undefined;
    }
    cancel(flowId) { if (this.flow?.id === flowId)
        this.cancelAll(); }
    async clear() { this.cancelAll(); await this.store.clear(); }
    async import(value) { this.cancelAll(); await this.store.import(value); }
    active(flow) {
        if (this.flow !== flow || flow.controller.signal.aborted || this.now() >= flow.expires || this.store.revision !== flow.revision)
            throw expired();
    }
    async request(path, controller, init = {}) {
        const timeout = new AbortController();
        const signal = AbortSignal.any([controller.signal, timeout.signal]);
        let timer;
        let onAbort;
        try {
            const aborted = new Promise((_, reject) => {
                onAbort = () => reject(failed());
                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted)
                    onAbort();
                timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT);
            });
            return await Promise.race([aborted, (async () => {
                    const url = ORIGIN + '/v2/plugin' + path;
                    const response = await this.fetcher(url, { method: 'GET', ...init, redirect: 'error', signal });
                    if (!response.ok || response.redirected || (response.url && response.url !== url))
                        throw failed();
                    const payload = object(await boundedJSON(response));
                    if (!payload)
                        throw failed();
                    return payload;
                })()]);
        }
        catch {
            throw failed();
        }
        finally {
            clearTimeout(timer);
            if (onAbort)
                signal.removeEventListener('abort', onAbort);
        }
    }
    async start() {
        this.cancelAll();
        const generation = this.generation, revision = this.store.revision, started = this.now();
        const controller = new AbortController();
        this.starting = controller;
        try {
            const payload = await this.request('/auth/state?platform=workbuddy', controller, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}',
            });
            const data = object(payload.data);
            if (!success(payload) || !data || typeof data.state !== 'string' || !data.state || data.state.length > 4096 || /[\x00-\x1f\x7f]/.test(data.state))
                throw failed();
            const verificationUri = verification(data.authUrl ?? data.auth_url ?? data.url, data.state);
            const expires = started + TTL, remaining = expires - this.now();
            if (generation !== this.generation || revision !== this.store.revision || remaining <= 0)
                throw expired();
            const id = randomBytes(32).toString('hex');
            this.flow = { id, state: data.state, expires, revision, nextPoll: 0, controller };
            // This is remaining lifetime, not a constant 600: upstream latency consumes the TTL.
            // Round up fractional seconds so a still-active flow never advertises zero lifetime.
            return { flowId: id, verificationUri, expiresIn: Math.ceil(remaining / 1000), interval: INTERVAL };
        }
        finally {
            if (this.starting === controller)
                this.starting = undefined;
        }
    }
    async poll(flowId) {
        const flow = this.flow;
        if (!flow || flow.id !== flowId)
            throw expired();
        this.active(flow);
        if (flow.completed)
            return { status: 'ok' };
        if (flow.running)
            return flow.running;
        if (this.now() < flow.nextPoll)
            return { status: 'pending', interval: INTERVAL };
        flow.nextPoll = this.now() + INTERVAL * 1000;
        flow.running = this.pollOnce(flow);
        try {
            return await flow.running;
        }
        finally {
            flow.running = undefined;
        }
    }
    async pollOnce(flow) {
        const payload = await this.request('/auth/token?state=' + encodeURIComponent(flow.state), flow.controller);
        this.active(flow);
        if (!success(payload))
            return { status: 'pending', interval: INTERVAL };
        const auth = object(payload.data);
        if (!auth)
            throw failed();
        if (auth.accessToken === undefined && auth.access_token === undefined)
            return { status: 'pending', interval: INTERVAL };
        personal(auth);
        const accessToken = token(auth);
        const accounts = await this.request('/accounts', flow.controller, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
        this.active(flow);
        const data = object(accounts.data);
        if (!success(accounts) || !Array.isArray(data?.accounts) || !data.accounts.length)
            throw failed();
        const rows = data.accounts.map(object);
        const account = rows.find(row => row?.lastLogin === true) ?? rows[0];
        if (!account)
            throw failed();
        const credential = parseCredential({ auth, account });
        this.active(flow);
        const saved = this.store.import(credential);
        flow.revision = this.store.revision;
        await saved;
        this.active(flow);
        flow.completed = true;
        return { status: 'ok' };
    }
}
//# sourceMappingURL=auth.js.map