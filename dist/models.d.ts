export interface DiscoveredModel {
    id: string;
    name: string;
    contextWindow?: number;
}
/**
 * Offline snapshot of models.dev limit.context values for official CLI model ids
 * (checked 2026-10-28). Used when models.dev cannot be reached so the context
 * window advertised to DSH stays honest without network access.
 */
export declare const STATIC_CONTEXT_WINDOWS: Record<string, number>;
/** Projects models.dev entries to last-segment id → largest advertised context window. */
export declare function parseContextRegistry(value: unknown): Map<string, number>;
export interface ModelDiscoveryResult {
    status: 'ok' | 'unavailable' | 'auth-required' | 'error';
    models: DiscoveredModel[];
    source: 'official-config' | 'cli-package';
    message: string;
    updatedAt?: string;
}
export interface ModelDiscovererOptions {
    bin?: string;
    fetch?: typeof globalThis.fetch;
    /** Explicit server-side AuthStore.read injection only. Never scans credential caches. */
    readCredentials?: () => Promise<unknown>;
    now?: () => Date;
    /** Set false to exclude installed package candidates; candidates are not entitlement checks. */
    packageFallback?: boolean;
    timeoutMs?: number;
}
/** Projects only known CLI model ids/names; never returns URLs, API keys or arbitrary metadata. */
export declare function parseModelConfiguration(value: unknown): DiscoveredModel[];
/**
 * Protocol evidence: official CLI 2.177.1 dist/codebuddy.js CloudProductProvider
 * uses /v3/config; CloudProductManager reads response.data.data.models and agents.
 * ProductEndpointHttpInterceptor sends X-Product: SaaS. Installed product.json
 * sets endpoint=https://www.codebuddy.ai and separates authentication internalDomain
 * (www.codebuddy.cn) from externalDomain (www.codebuddy.ai). Both use /v3/config.
 * It defines models plus agents[name=cli].models. No bundled ids are copied here.
 * Anonymous requests can return code=0/models=null: that is NOT a model list.
 */
export declare function createModelDiscoverer(options?: ModelDiscovererOptions): () => Promise<ModelDiscoveryResult>;
