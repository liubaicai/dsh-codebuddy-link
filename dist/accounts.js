import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AuthManager, parseCredential } from "./auth.js";
import { settingsPath } from "./settings.js";
const LIMIT = 512 * 1024;
export const MAX_ACCOUNTS = 20;
const failure = () => new Error('Cannot read CodeBuddy accounts; repair the account store before continuing');
const invalid = () => new Error('Invalid CodeBuddy account configuration');
const missing = () => new Error('CodeBuddy account does not exist');
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw invalid();
    return value;
}
function keys(value, allowed) {
    if (Object.keys(value).some(key => !allowed.includes(key)))
        throw invalid();
}
function validName(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
}
function publicAccount(account) {
    return { id: account.id, name: account.name, enabled: account.enabled, authState: account.authState, createdAt: account.createdAt };
}
function empty() { return { version: 1, managed: true, revision: 0, mode: 'fixed', accounts: [] }; }
function validate(value) {
    const root = object(value);
    keys(root, ['version', 'managed', 'revision', 'mode', 'selectedAccountId', 'accounts']);
    if (root.version !== 1 || root.managed !== true || !Number.isSafeInteger(root.revision) || root.revision < 0 ||
        (root.mode !== 'fixed' && root.mode !== 'pool') || !Array.isArray(root.accounts) || root.accounts.length > MAX_ACCOUNTS)
        throw invalid();
    const ids = new Set(), uids = new Set();
    const accounts = root.accounts.map(value => {
        const row = object(value);
        keys(row, ['id', 'name', 'enabled', 'authState', 'createdAt', 'credential']);
        if (typeof row.id !== 'string' || !/^[a-f0-9]{32}$/.test(row.id) || ids.has(row.id) || !validName(row.name) ||
            typeof row.enabled !== 'boolean' || (row.authState !== 'ready' && row.authState !== 'auth-required') ||
            typeof row.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.createdAt) ||
            !Number.isFinite(Date.parse(row.createdAt)) || new Date(row.createdAt).toISOString() !== row.createdAt)
            throw invalid();
        const credentialObject = object(row.credential);
        keys(credentialObject, ['accessToken', 'uid']);
        const credential = parseCredential(credentialObject);
        if (uids.has(credential.uid))
            throw invalid();
        ids.add(row.id);
        uids.add(credential.uid);
        return { id: row.id, name: row.name, enabled: row.enabled, authState: row.authState, createdAt: row.createdAt, credential };
    });
    if (root.selectedAccountId !== undefined && (typeof root.selectedAccountId !== 'string' || root.mode !== 'fixed' ||
        !accounts.some(row => row.id === root.selectedAccountId && row.enabled)))
        throw invalid();
    return { version: 1, managed: true, revision: root.revision, mode: root.mode, accounts,
        ...(root.selectedAccountId === undefined ? {} : { selectedAccountId: root.selectedAccountId }) };
}
/** Reject symlinks/junctions in every existing ancestor, not just the leaf directory. */
function safeDirectories(path) {
    let current = dirname(resolve(path));
    for (;;) {
        try {
            const stat = lstatSync(current);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw invalid();
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        const parent = dirname(current);
        if (parent === current)
            return;
        current = parent;
    }
}
function readJSON(path, limit) {
    let fd;
    try {
        safeDirectories(path);
        let before;
        try {
            before = lstatSync(path);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return undefined;
            throw error;
        }
        if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > limit)
            throw invalid();
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stat = fstatSync(fd), after = lstatSync(path);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || after.isSymbolicLink() || stat.dev !== before.dev || stat.ino !== before.ino ||
            stat.dev !== after.dev || stat.ino !== after.ino)
            throw invalid();
        const bytes = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = readSync(fd, bytes, length, bytes.length - length, length);
            if (!count)
                break;
            length += count;
        }
        if (length > limit)
            throw invalid();
        return JSON.parse(bytes.subarray(0, length).toString('utf8'));
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
/** Secrets stay on disk or in read(id); every UI-facing method explicitly projects metadata. */
export class AccountStore {
    path;
    legacyPath;
    observedManaged = false;
    observedRevision = 0;
    constructor(path = join(dirname(settingsPath()), 'accounts.json'), legacyPath = join(dirname(path), 'credentials.json')) {
        this.path = resolve(path);
        this.legacyPath = resolve(legacyPath);
        if (this.path === this.legacyPath)
            throw invalid();
    }
    get revision() { this.load(); return this.observedRevision; }
    hasManagedAccounts() { this.load(); return this.observedManaged; }
    load() {
        try {
            const value = readJSON(this.path, LIMIT);
            if (value !== undefined) {
                const state = validate(value);
                if (state.revision < this.observedRevision)
                    throw invalid();
                this.observedManaged = true;
                this.observedRevision = state.revision;
                return state;
            }
            // An externally removed managed file is an error, never an invitation to rediscover credentials.
            if (this.observedManaged)
                throw invalid();
            const legacy = readJSON(this.legacyPath, 64 * 1024);
            if (legacy === undefined)
                return empty();
            const credential = parseCredential(legacy), state = empty();
            const account = this.newAccount(credential);
            state.accounts.push(account);
            state.selectedAccountId = account.id;
            this.commit(state, true);
            return state;
        }
        catch {
            throw failure();
        }
    }
    newAccount(credential) {
        return { id: randomBytes(16).toString('hex'), name: 'CodeBuddy account', enabled: true,
            authState: 'ready', createdAt: new Date().toISOString(), credential };
    }
    commit(state, createOnly = false) {
        if (state.revision >= Number.MAX_SAFE_INTEGER)
            throw invalid();
        state.revision++;
        validate(state);
        const data = JSON.stringify(state) + '\n';
        if (Buffer.byteLength(data) > LIMIT)
            throw invalid();
        const tmp = this.path + '.' + randomBytes(16).toString('hex') + '.tmp';
        let fd;
        try {
            safeDirectories(this.path);
            mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
            safeDirectories(this.path);
            // Do not follow or replace an existing link, even though rename itself would replace the link.
            try {
                const stat = lstatSync(this.path);
                if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || createOnly)
                    throw invalid();
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
            chmodSync(dirname(this.path), 0o700);
            fd = openSync(tmp, 'wx', 0o600);
            writeFileSync(fd, data, 'utf8');
            fsyncSync(fd);
            closeSync(fd);
            fd = undefined;
            chmodSync(tmp, 0o600);
            if (createOnly || !this.observedManaged) {
                // Exclusive publication: first use/migration must never overwrite a store created concurrently.
                linkSync(tmp, this.path);
                unlinkSync(tmp);
            }
            else
                renameSync(tmp, this.path);
            this.observedManaged = true;
            this.observedRevision = state.revision;
        }
        catch {
            throw new Error('Cannot save CodeBuddy accounts');
        }
        finally {
            if (fd !== undefined)
                closeSync(fd);
            try {
                unlinkSync(tmp);
            }
            catch { /* owned temporary file only */ }
        }
    }
    list() { return this.load().accounts.map(publicAccount); }
    snapshot() {
        const state = this.load();
        return { mode: state.mode, ...(state.selectedAccountId === undefined ? {} : { selectedAccountId: state.selectedAccountId }), accounts: state.accounts.map(publicAccount) };
    }
    async read(id) {
        const row = this.load().accounts.find(row => row.id === id);
        return row ? { ...row.credential } : undefined;
    }
    async upsert(value, targetId) {
        const credential = parseCredential(value), state = this.load();
        let row;
        if (targetId !== undefined) {
            row = state.accounts.find(account => account.id === targetId);
            if (!row)
                throw missing();
            if (row.credential.uid !== credential.uid)
                throw new Error('Reauthorization must use the same CodeBuddy account');
        }
        else
            row = state.accounts.find(account => account.credential.uid === credential.uid);
        if (row) {
            row.credential = credential;
            row.authState = 'ready';
        }
        else {
            if (state.accounts.length >= MAX_ACCOUNTS)
                throw new Error('CodeBuddy account limit reached');
            row = this.newAccount(credential);
            state.accounts.push(row);
            if (state.accounts.length === 1 && state.mode === 'fixed')
                state.selectedAccountId = row.id;
        }
        this.commit(state);
        return publicAccount(row);
    }
    async update(id, patch) {
        const update = object(patch);
        keys(update, ['name', 'enabled']);
        if ('name' in update && !validName(update.name) || 'enabled' in update && typeof update.enabled !== 'boolean')
            throw invalid();
        const state = this.load(), row = state.accounts.find(account => account.id === id);
        if (!row)
            throw missing();
        if (patch.name !== undefined)
            row.name = patch.name.trim();
        if (patch.enabled !== undefined)
            row.enabled = patch.enabled;
        if (!row.enabled && state.selectedAccountId === id)
            delete state.selectedAccountId;
        this.commit(state);
        return publicAccount(row);
    }
    async remove(id) {
        const state = this.load(), index = state.accounts.findIndex(account => account.id === id);
        if (index < 0)
            throw missing();
        state.accounts.splice(index, 1);
        if (state.selectedAccountId === id)
            delete state.selectedAccountId;
        this.commit(state);
    }
    async clear() {
        const state = this.load();
        state.accounts = [];
        delete state.selectedAccountId;
        this.commit(state);
    }
    async configure(configuration) {
        const config = object(configuration);
        keys(config, ['mode', 'accountId']);
        if ((config.mode !== 'fixed' && config.mode !== 'pool') || ('accountId' in config && typeof config.accountId !== 'string') ||
            (config.mode === 'pool' && config.accountId !== undefined))
            throw invalid();
        const state = this.load();
        if (config.mode === 'fixed') {
            const id = config.accountId ?? state.selectedAccountId;
            if (typeof id !== 'string' || !state.accounts.some(account => account.id === id && account.enabled))
                throw invalid();
            state.selectedAccountId = id;
        }
        else
            delete state.selectedAccountId;
        state.mode = config.mode;
        this.commit(state);
        return this.snapshot();
    }
    async markAuthRequired(id, expectedToken) {
        const state = this.load(), row = state.accounts.find(account => account.id === id);
        if (!row) {
            if (expectedToken !== undefined)
                return;
            throw missing();
        }
        // Compare and persist without an await: a stale request cannot disable new credentials.
        if (expectedToken !== undefined && row.credential.accessToken !== expectedToken)
            return;
        if (row.authState === 'auth-required')
            return;
        row.authState = 'auth-required';
        this.commit(state);
    }
}
/** Reuses the fixed-origin, bounded, cancelable personal-CN OAuth protocol without exporting secrets. */
export class AccountAuthManager {
    store;
    manager;
    targetId;
    constructor(store, options = {}) {
        this.store = store;
        const adapter = {
            get revision() { return store.revision; },
            import: async (value) => { await store.upsert(parseCredential(value), this.targetId); },
            clear: () => store.clear(),
        };
        this.manager = new AuthManager(adapter, options);
    }
    async start(accountId) {
        this.cancelAll();
        if (accountId !== undefined && !this.store.list().some(account => account.id === accountId))
            throw missing();
        this.targetId = accountId;
        return this.manager.start();
    }
    poll(flowId) { return this.manager.poll(flowId); }
    cancel(flowId) { this.manager.cancel(flowId); }
    cancelAll() { this.manager.cancelAll(); this.targetId = undefined; }
    async clear() { this.cancelAll(); await this.store.clear(); }
}
//# sourceMappingURL=accounts.js.map