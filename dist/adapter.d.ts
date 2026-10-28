import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { type PluginConfig } from './config.ts';
import { CallRuntime } from './runtime.ts';
import { runCodeBuddy } from './runner.ts';
export type Runner = typeof runCodeBuddy;
export { CODEBUDDY_EFFORTS, type CodeBuddyEffort } from './config.ts';
export declare class CodeBuddyAdapter extends LlmAdapter {
    private readonly config;
    private readonly runner;
    private readonly sessionCwd;
    private readonly authToken;
    private readonly runtime;
    constructor(config: PluginConfig, runner?: Runner, sessionCwd?: (id: string) => string | undefined, authToken?: () => Promise<string | undefined>, runtime?: CallRuntime);
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
