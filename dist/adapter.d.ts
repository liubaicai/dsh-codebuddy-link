import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { PluginConfig } from './config.ts';
import { runCodeBuddy } from './runner.ts';
export type Runner = typeof runCodeBuddy;
/** Reasoning effort levels accepted by the CodeBuddy CLI --effort flag (verified against CLI 2.177.1). */
export declare const CODEBUDDY_EFFORTS: readonly ["minimal", "low", "medium", "high", "xhigh", "max", "ultracode"];
export type CodeBuddyEffort = (typeof CODEBUDDY_EFFORTS)[number];
export declare class CodeBuddyAdapter extends LlmAdapter {
    private readonly config;
    private readonly runner;
    private readonly sessionCwd;
    private readonly authToken;
    constructor(config: PluginConfig, runner?: Runner, sessionCwd?: (id: string) => string | undefined, authToken?: () => Promise<string | undefined>);
    /** Saved plugin credential, when present and readable, authenticates the CLI child. */
    private resolveAuthToken;
    providerInfo(): {
        id: string;
        name: string;
    };
    listModels(): Promise<readonly LlmModelInfo[]>;
    resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
