export interface Credential {
    accessToken: string;
    uid: string;
}
/** Strict JSON only: no bare tokens, no credential discovery and no refresh tokens retained. */
export declare function parseCredential(input: unknown): Credential;
export declare class AuthStore {
    readonly path: string;
    private generation;
    get revision(): number;
    constructor(path?: string);
    read(): Promise<Credential | undefined>;
    status(): Promise<{
        configured: boolean;
    }>;
    import(value: unknown): Promise<void>;
    clear(): Promise<void>;
}
/** Minimal persistence surface shared by legacy and managed-account OAuth. */
export interface AuthCredentialStore {
    readonly revision: number;
    import(value: unknown): Promise<void>;
    clear(): Promise<void>;
}
export interface AuthManagerOptions {
    fetch?: typeof globalThis.fetch;
    now?: () => number;
}
export interface AuthStart {
    flowId: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
}
export type AuthPoll = {
    status: 'pending';
    interval: number;
} | {
    status: 'ok';
};
export declare class AuthManager<Store extends AuthCredentialStore = AuthStore> {
    private readonly fetcher;
    private readonly now;
    private flow?;
    private generation;
    private starting?;
    readonly store: Store;
    constructor(store: Store, options?: AuthManagerOptions);
    cancelAll(): void;
    cancel(flowId: string): void;
    clear(): Promise<void>;
    import(value: unknown): Promise<void>;
    private active;
    private request;
    start(): Promise<AuthStart>;
    poll(flowId: string): Promise<AuthPoll>;
    private pollOnce;
}
