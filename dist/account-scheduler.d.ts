export interface AccountSummary {
    id: string;
    name: string;
    enabled: boolean;
    authState: 'ready' | 'auth-required';
}
export interface AccountSnapshot {
    mode: 'fixed' | 'pool';
    selectedAccountId?: string;
    accounts: AccountSummary[];
    managed?: boolean;
}
export interface AccountLease {
    accountId: string;
    accountName: string;
    authToken: string;
    /** Release only after the caller has finished child/process/transport cleanup. Idempotent. */
    release(): void;
}
export interface AccountSchedulerOptions {
    snapshot(): Promise<AccountSnapshot>;
    readCredential(id: string): Promise<{
        accessToken: string;
        uid: string;
    } | undefined>;
    /** Read once per acquisition; defaults to 60 seconds. */
    queueTimeoutMs?: () => number;
    maxPerAccount?: number;
    /** Maximum retained session bindings (LRU); zero disables idle affinity. Default 1024. */
    maxAffinity?: number;
    /** Only explicit false disallows a model. Discovery catalogs are NOT entitlement lists. */
    isModelAllowed?: (account: AccountSummary, model: string) => boolean | undefined;
}
export interface AccountAcquireOptions {
    sessionId?: string;
    model?: string;
    signal?: AbortSignal;
}
/**
 * Process-local account scheduling only: never invokes, retries, or replays an operation.
 * A queued choice is pinned, then revalidated before grant. Reconfiguration invalidates
 * that acquisition rather than silently switching its identity. New acquisitions may
 * rebind an ineligible/evicted session. No credentials are kept in scheduler state.
 */
export declare class AccountScheduler {
    private readonly options;
    private readonly maxPerAccount;
    private readonly maxAffinity;
    private readonly affinity;
    private readonly active;
    private readonly activeBindings;
    private readonly queue;
    private lastAccountId;
    private revision;
    private pumping;
    private dirty;
    constructor(options: AccountSchedulerOptions);
    /** Detached token-free counts, including slots reserved while credentials are read. */
    activeCounts(): Record<string, number>;
    /** Wake queued acquisitions after account settings or authentication state changes. */
    refresh(): void;
    acquire(request?: AccountAcquireOptions): Promise<AccountLease>;
    private wake;
    private snapshot;
    private allowed;
    private validate;
    private choose;
    private pump;
    private reserve;
    private grant;
    private remove;
    private fail;
}
