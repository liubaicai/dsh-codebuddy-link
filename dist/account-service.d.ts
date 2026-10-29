import { AccountStore, type AccountConfiguration } from './accounts.ts';
import { AccountScheduler, type AccountLease } from './account-scheduler.ts';
import { type ModelDiscoveryResult } from './models.ts';
import type { AccountStatus } from './web.ts';
import type { PluginConfig } from './config.ts';
import type { RuntimeAccounts } from './runtime.ts';
import type { CodeBuddyRequest } from './runner.ts';
/** Per-identity diagnostics only; never caches credentials or mistakes catalog entries for entitlements. */
export declare class AccountService implements RuntimeAccounts {
    readonly scheduler: AccountScheduler;
    private readonly quotas;
    private readonly catalogs;
    private readonly pending;
    private readonly localRefresh;
    readonly store: AccountStore;
    private readonly config;
    constructor(store: AccountStore, config: PluginConfig);
    acquire(request: CodeBuddyRequest): Promise<AccountLease | undefined>;
    beforeRun(lease: AccountLease | undefined): Promise<string | undefined>;
    invalidate(id: string, authToken?: string): Promise<void>;
    snapshot(): {
        accounts: {
            catalogModels?: import("./models.ts").DiscoveredModel[] | undefined;
            quota?: AccountStatus | undefined;
            active: number;
            id: string;
            name: string;
            enabled: boolean;
            authState: "ready" | "auth-required";
            createdAt: string;
        }[];
        mode: "fixed" | "pool";
        selectedAccountId?: string;
    };
    update(id: string, patch: {
        name?: string;
        enabled?: boolean;
    }): Promise<void>;
    remove(id: string): Promise<void>;
    configure(value: AccountConfiguration): Promise<void>;
    changed(): void;
    refresh(id?: string): Promise<AccountStatus>;
    discover(): Promise<{
        models: ModelDiscoveryResult['models'];
        message?: string;
    }>;
    private query;
}
