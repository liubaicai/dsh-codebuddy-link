import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SettingsStore } from './settings.ts';
export interface AccountStatus {
    status: 'ok' | 'unavailable' | 'auth-required' | 'error';
    message?: string;
    remaining?: number;
    total?: number;
    used?: number;
    unit?: string;
    updatedAt?: string;
    source?: string;
}
export interface WebServerLike {
    register(route: {
        kind: 'exact';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void;
    }): unknown;
}
export interface AuthService {
    status(): Promise<{
        configured: boolean;
    }>;
    import(value: unknown): Promise<void>;
    clear(): Promise<void>;
    start(): Promise<unknown>;
    poll(flowId: string): Promise<unknown>;
    cancel(flowId: string): unknown;
    cancelAll(): void;
}
export declare function registerSettingsRoutes(server: WebServerLike, store: SettingsStore, notify: () => void, refreshAccount?: () => Promise<AccountStatus>, auth?: AuthService, refreshModels?: () => Promise<{
    models: {
        id: string;
        name: string;
        contextWindow?: number;
    }[];
    message?: string;
}>): () => void;
