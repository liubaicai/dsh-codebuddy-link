export interface PluginConfig {
    enabled: boolean;
    codebuddyBin: string;
    defaultModel: string;
    models: string[];
    hiddenModels: string[];
    workspaceRoot: string;
    permissionMode: 'dontAsk' | 'plan' | 'acceptEdits';
    tools: string;
    timeoutMs: number;
    contextWindow: number;
    /** Per-model context windows (models.dev) persisted by model discovery. */
    modelContext: Record<string, number>;
    maxPromptChars: number;
    askTool: boolean;
}
export declare function resolveConfig(entry?: Record<string, unknown>, env?: NodeJS.ProcessEnv): PluginConfig;
