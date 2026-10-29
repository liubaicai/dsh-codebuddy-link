import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm';
/** @deprecated Legacy parser compatibility only; provider replies are opaque ACP output. */
export { parseResponse } from './response.ts';
/** Wire instructions belong outside the quoted conversation, at system priority. */
export declare const RESPONSE_CONTRACT: string;
export declare function buildSystemPrompt(system: string | undefined, hasTools: boolean): string | undefined;
export declare const AUTONOMOUS_CONTRACT: string;
export declare function autonomousSystemPrompt(system: string | undefined): string;
export declare function buildPrompt(messages: readonly Message[], tools: readonly ToolSchema[], maxChars: number, autonomous?: boolean): string;
export declare const RESPONSE_SCHEMA: Record<string, unknown>;
