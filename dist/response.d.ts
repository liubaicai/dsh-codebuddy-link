import type { ToolSchema } from '@deepseek-ai/dsh-llm';
export interface NormalizedResponse {
    text: string;
    toolCalls: {
        name: string;
        arguments: string;
    }[];
}
/** Broad wire-format compatibility is deliberately anchored at response level.
 * Explanations/code examples are text, not a source of executable fragments. */
export declare function parseResponse(value: unknown, tools: readonly ToolSchema[]): NormalizedResponse;
