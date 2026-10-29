export type BridgeEvent = {
    type: 'text' | 'reasoning';
    delta: string;
} | {
    type: 'usage';
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
} | {
    type: 'metadata';
    model?: string;
    totalCredits?: number;
    totalCostUsd?: number;
} | {
    type: 'tool-start';
    id: string;
    name: string;
    input?: unknown;
} | {
    type: 'tool-end';
    id: string;
    name?: string;
    output?: unknown;
    isError?: boolean;
} | {
    type: 'result';
    sessionId?: string;
    text: string;
    structuredOutput?: unknown;
    partialSuccess?: boolean;
};
/** Incremental UTF-8 NDJSON framing. Final unterminated lines are valid. */
export declare class NdjsonDecoder {
    private decoder;
    private pending;
    private readonly maxLineBytes;
    constructor(maxLineBytes?: number);
    push(chunk: Buffer | string): unknown[];
    finish(): unknown[];
    private consume;
}
/** Stateful Claude-compatible CodeBuddy stream-json adapter. Usage events are cumulative snapshots. */
export declare class CodeBuddyProtocol {
    private sessionId?;
    private activeId;
    private sequence;
    private streamed;
    private usages;
    private tools;
    private endedTools;
    private assistantIds;
    private output;
    private lastUsage;
    private done;
    get hasResult(): boolean;
    accept(value: unknown): BridgeEvent[];
    /**
     * When the API call fails, the CLI relays the status line (e.g. "401
     * Unauthorized") as the entire assistant message. In --json-schema mode the
     * CLI then never emits a result row and never exits, so the request would
     * hang until the timeout. A bare HTTP status line is never legitimate model
     * output: fail fast instead of streaming it as text.
     */
    private rejectEchoedHttpError;
    private delta;
    private startTool;
    private emitMetadata;
    private parseUsage;
    private updateUsage;
    private emitUsage;
}
