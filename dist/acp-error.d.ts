/** Only fixed copy and a validated reset timestamp leave the error boundary. */
export declare class CodeBuddyLimitError extends Error {
    readonly code: 'QUOTA' | 'CODEBUDDY_RATE_LIMIT';
    readonly status?: number;
    constructor(quota: boolean, status?: number, reset?: string);
}
/** Inspect only ACP error surfaces, never assistant text, tool output or stderr. */
export declare function acpLimitError(value: unknown): CodeBuddyLimitError | undefined;
