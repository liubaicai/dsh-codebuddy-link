export declare const CODEBUDDY_EFFORTS: readonly ["auto", "minimal", "low", "medium", "high", "xhigh", "max", "ultracode"];
export type CodeBuddyEffort = typeof CODEBUDDY_EFFORTS[number];
export declare function isCodeBuddyEffort(value: unknown): value is CodeBuddyEffort;
export interface PluginConfig {
    enabled: boolean;
    codebuddyBin: string;
    defaultModel: string;
    models: string[];
    hiddenModels: string[];
    workspaceRoot: string;
    permissionMode: 'dontAsk' | 'plan' | 'acceptEdits';
    tools: string;
    /** Fixed: provider calls always run through ACP autonomous execution. */
    executionMode: 'autonomous';
    dangerouslySkipPermissions: boolean;
    /** ACP inactivity budget; print-mode delegation/background total budget. */
    timeoutMs: number;
    reasoningEffort: string;
    maxConcurrency: number;
    queueTimeoutMs: number;
    stallWarnMs: number;
    contextWindow: number;
    /** Per-model context windows (models.dev) persisted by model discovery. */
    modelContext: Record<string, number>;
    maxPromptChars: number;
    askTool: boolean;
}
export declare function resolveConfig(entry?: Record<string, unknown>, env?: NodeJS.ProcessEnv): PluginConfig;
