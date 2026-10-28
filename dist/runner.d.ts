import { type BridgeEvent } from './protocol.ts';
export type { BridgeEvent } from './protocol.ts';
export interface CodeBuddyRequest {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    model?: string;
    effort?: string;
    /** Internal lifecycle notification; never passed to the CLI. */
    onSpawn?: () => void;
    permissionMode?: 'dontAsk' | 'plan' | 'acceptEdits';
    tools?: string;
    bin?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    jsonSchema?: Record<string, unknown>;
    /** Bearer token forwarded as CODEBUDY_AUTH_TOKEN; overrides the CLI's own stored login. */
    authToken?: string;
}
/** Resolve npm's Windows launchers without ever invoking cmd.exe or PowerShell. */
export declare function resolveCodeBuddyBin(bin?: string, cwd?: string): Promise<{
    command: string;
    args: string[];
}>;
/**
 * Children must run as plain Node. When the DSH host is an Electron app,
 * process.execPath is the GUI binary: spawning it with a script argument would
 * start a second GUI instance that never answers and hangs the request until
 * timeout. ELECTRON_RUN_AS_NODE makes an Electron binary behave as plain Node;
 * a real Node executable simply ignores the variable.
 */
export declare function childEnv(authToken?: string): NodeJS.ProcessEnv;
/** One fresh CLI process per call; the complete conversation belongs in prompt. */
export declare function runCodeBuddy(request: CodeBuddyRequest): AsyncGenerator<BridgeEvent>;
