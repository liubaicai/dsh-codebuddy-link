import { AccountStore } from "./accounts.js";
import { AccountScheduler } from "./account-scheduler.js";
import { createAccountRefresher } from "./credits.js";
import { createModelDiscoverer } from "./models.js";
/** Per-identity diagnostics only; never caches credentials or mistakes catalog entries for entitlements. */
export class AccountService {
    scheduler;
    quotas = new Map();
    catalogs = new Map();
    pending = new Map();
    localRefresh = createAccountRefresher();
    store;
    config;
    constructor(store, config) {
        this.store = store;
        this.config = config;
        this.scheduler = new AccountScheduler({
            snapshot: async () => store.snapshot(), readCredential: id => store.read(id),
            queueTimeoutMs: () => config.queueTimeoutMs,
        });
    }
    async acquire(request) {
        // Only installations which have NEVER managed an account may use CLI-local login.
        if (!this.store.hasManagedAccounts())
            return undefined;
        return this.scheduler.acquire({ sessionId: request.sessionId, model: request.model, signal: request.signal });
    }
    async beforeRun(lease) {
        if (!lease) {
            if (this.store.hasManagedAccounts())
                throw new Error('CodeBuddy account management changed while queued; submit the request again');
            return undefined;
        }
        const snapshot = this.store.snapshot();
        const account = snapshot.accounts.find(row => row.id === lease.accountId);
        if (!account?.enabled || account.authState !== 'ready' || (snapshot.mode === 'fixed' && snapshot.selectedAccountId !== account.id)) {
            throw new Error('CodeBuddy account selection changed while queued; submit the request again');
        }
        const credential = await this.store.read(account.id);
        if (!credential)
            throw new Error('CodeBuddy account requires authorization');
        return credential.accessToken;
    }
    async invalidate(id, authToken) {
        // An old in-flight failure must not invalidate a freshly reauthorized credential.
        await this.store.markAuthRequired(id, authToken);
        this.scheduler.refresh();
    }
    snapshot() {
        const value = this.store.snapshot(), active = this.scheduler.activeCounts();
        return { ...value, accounts: value.accounts.map(row => ({ ...row, active: active[row.id] ?? 0,
                ...(this.quotas.has(row.id) ? { quota: this.quotas.get(row.id) } : {}),
                ...(this.catalogs.has(row.id) ? { catalogModels: this.catalogs.get(row.id).models } : {}),
            })) };
    }
    async update(id, patch) {
        await this.store.update(id, patch);
        this.scheduler.refresh();
    }
    async remove(id) {
        await this.store.remove(id);
        this.quotas.delete(id);
        this.catalogs.delete(id);
        this.pending.clear();
        this.scheduler.refresh();
    }
    async configure(value) { await this.store.configure(value); this.scheduler.refresh(); }
    changed() { this.quotas.clear(); this.catalogs.clear(); this.pending.clear(); this.scheduler.refresh(); }
    async refresh(id) {
        if (!this.store.hasManagedAccounts())
            return this.localRefresh();
        const rows = this.store.list();
        if (id && !rows.some(row => row.id === id))
            throw new Error('CodeBuddy account does not exist');
        await Promise.all(rows.filter(row => !id || row.id === id).map(row => this.query(row.id, false)));
        const selected = this.store.snapshot().selectedAccountId;
        return this.quotas.get(id ?? selected ?? '') ?? { status: 'unavailable' };
    }
    async discover() {
        if (!this.store.hasManagedAccounts())
            return createModelDiscoverer({ bin: this.config.codebuddyBin })();
        const rows = this.store.list().filter(row => row.enabled && row.authState === 'ready');
        await Promise.all(rows.map(row => this.query(row.id, true)));
        return { models: [...new Map(rows.flatMap(row => this.catalogs.get(row.id)?.models ?? []).map(model => [model.id, model])).values()] };
    }
    query(id, models) {
        const revision = this.store.revision, key = `${revision}:${id}:${models}`;
        const existing = this.pending.get(key);
        if (existing)
            return existing;
        const task = (async () => {
            // Bind this query to one credential, not a global metadata revision: an
            // unrelated account becoming invalid must not discard healthy results.
            const credential = await this.store.read(id);
            if (!credential)
                return;
            const read = async () => credential;
            const current = async () => {
                const value = await this.store.read(id);
                return value?.accessToken === credential.accessToken && value.uid === credential.uid;
            };
            if (models) {
                const value = await createModelDiscoverer({ bin: this.config.codebuddyBin, readCredentials: read })();
                if (await current())
                    this.catalogs.set(id, value);
            }
            else {
                const value = await createAccountRefresher({ readCredentials: async () => {
                        const login = await read();
                        if (!login)
                            throw new Error('Missing account credential');
                        return { auth: { accessToken: login.accessToken, tokenType: 'Bearer' }, account: { uid: login.uid } };
                    } })();
                if (await current()) {
                    this.quotas.set(id, value);
                    if (value.status === 'auth-required')
                        await this.invalidate(id, credential.accessToken);
                }
            }
        })().finally(() => { if (this.pending.get(key) === task)
            this.pending.delete(key); });
        this.pending.set(key, task);
        return task;
    }
}
//# sourceMappingURL=account-service.js.map