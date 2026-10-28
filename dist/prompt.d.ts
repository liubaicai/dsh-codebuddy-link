import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm';
export { parseResponse } from './response.ts';
export declare function buildPrompt(messages: readonly Message[], tools: readonly ToolSchema[], maxChars: number): string;
export declare const RESPONSE_SCHEMA: Record<string, unknown>;
