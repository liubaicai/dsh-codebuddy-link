import type { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-commands';
import { CodeBuddyAdapter } from './adapter.ts';
import { resolveConfig } from './config.ts';
export declare const name = "dsh-codebuddy-link";
export declare const inject: string[];
export declare function apply(ctx: Context, entry?: Record<string, unknown>): void;
export { CodeBuddyAdapter, resolveConfig };
