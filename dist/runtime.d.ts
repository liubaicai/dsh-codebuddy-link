import { type PluginConfig } from './config.ts';
import { runCodeBuddy, type CodeBuddyRequest, type BridgeEvent } from './runner.ts';
import type { AccountLease } from './account-scheduler.ts';
export interface RuntimeAccounts {
    acquire(request: CodeBuddyRequest): Promise<AccountLease | undefined>;
    invalidate(accountId: string, authToken?: string): Promise<void>;
    beforeRun?(lease: AccountLease | undefined): Promise<string | undefined>;
}
export interface RunSnapshot {
    id: string;
    source: 'model' | 'ask';
    state: 'queued' | 'starting' | 'waiting' | 'responding' | 'completed' | 'failed' | 'cancelled';
    requestedModel: string;
    returnedModel?: string;
    accountId?: string;
    accountName?: string;
    requestedEffort: string;
    contextWindow?: number;
    contextSource?: 'model' | 'fallback';
    contextOverrideSent: false;
    reasoningConfirmed: false;
    queuedAt: number;
    startedAt?: number;
    lastProgressAt?: number;
    endedAt?: number;
    warning: boolean;
    queuePosition: number;
    totalCredits?: number;
    totalCostUsd?: number;
    failure?: 'timeout' | 'queue-timeout' | 'aborted' | 'error';
}
/** Process-local FIFO shared by provider and ask calls. Never stores prompts, argv, paths or errors. */
export declare class CallRuntime {
    private readonly config;
    private readonly records;
    private readonly queue;
    private active;
    private readonly accounts?;
    constructor(config: PluginConfig, accounts?: RuntimeAccounts);
    snapshots(): RunSnapshot[];
    private prune;
    /** Re-evaluate live concurrency changes without interrupting active calls. */
    refresh(): void;
    private pump;
    private acquire;
    run(request: CodeBuddyRequest, source: 'model' | 'ask', runner?: typeof runCodeBuddy, validate?: (event: Extract<BridgeEvent, {
        type: 'result';
    }>) => void): AsyncGenerator<BridgeEvent>;
}
