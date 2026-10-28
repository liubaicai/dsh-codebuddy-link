import { type PluginConfig } from './config.ts';
import { runCodeBuddy, type CodeBuddyRequest, type BridgeEvent } from './runner.ts';
export interface RunSnapshot {
    id: string;
    source: 'model' | 'ask';
    state: 'queued' | 'starting' | 'waiting' | 'responding' | 'completed' | 'failed' | 'cancelled';
    requestedModel: string;
    returnedModel?: string;
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
    constructor(config: PluginConfig);
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
