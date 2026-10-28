import { type CodeBuddyEffort } from './config.ts';
/** An explicit auto uses the CLI default; omission inherits the plugin default. */
export declare function resolveEffort(value: unknown, fallback: string): CodeBuddyEffort | undefined;
