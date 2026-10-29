import { type AuthManagerOptions, type AuthPoll, type AuthStart, type Credential } from './auth.ts';
export declare const MAX_ACCOUNTS = 20;
export interface AccountMetadata {
    id: string;
    name: string;
    enabled: boolean;
    authState: 'ready' | 'auth-required';
    createdAt: string;
}
export interface AccountSnapshot {
    mode: 'fixed' | 'pool';
    selectedAccountId?: string;
    accounts: AccountMetadata[];
}
export interface AccountConfiguration {
    mode: 'fixed' | 'pool';
    accountId?: string;
}
/** Secrets stay on disk or in read(id); every UI-facing method explicitly projects metadata. */
export declare class AccountStore {
    readonly path: string;
    readonly legacyPath: string;
    private observedManaged;
    private observedRevision;
    constructor(path?: string, legacyPath?: string);
    get revision(): number;
    hasManagedAccounts(): boolean;
    private load;
    private newAccount;
    private commit;
    list(): AccountMetadata[];
    snapshot(): AccountSnapshot;
    read(id: string): Promise<Credential | undefined>;
    upsert(value: Credential, targetId?: string): Promise<AccountMetadata>;
    update(id: string, patch: {
        name?: string;
        enabled?: boolean;
    }): Promise<AccountMetadata>;
    remove(id: string): Promise<void>;
    clear(): Promise<void>;
    configure(configuration: AccountConfiguration): Promise<AccountSnapshot>;
    markAuthRequired(id: string, expectedToken?: string): Promise<void>;
}
/** Reuses the fixed-origin, bounded, cancelable personal-CN OAuth protocol without exporting secrets. */
export declare class AccountAuthManager {
    readonly store: AccountStore;
    private readonly manager;
    private targetId?;
    constructor(store: AccountStore, options?: AuthManagerOptions);
    start(accountId?: string): Promise<AuthStart>;
    poll(flowId: string): Promise<AuthPoll>;
    cancel(flowId: string): void;
    cancelAll(): void;
    clear(): Promise<void>;
}
