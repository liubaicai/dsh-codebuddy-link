import type { AccountStatus } from './web.ts';
export interface AccountRefresherOptions {
    fetch?: typeof globalThis.fetch;
    /** Explicit opt-in JSON file; no credential discovery, decryption or login mutation. */
    credentialsFile?: string;
    /** Returns the parsed plain CLI session shape, not a token string. */
    readCredentials?: () => Promise<unknown>;
    now?: () => Date;
}
/**
 * Experimental protocol adapter, independently implemented from public field evidence:
 * cockpit-tools src/utils/codebuddy-suite/{parser,quota-model.test}.ts and
 * crates/cockpit-core/src/modules/codebuddy_cn_oauth.rs. No OAuth/refresh code used.
 * Official CLI 2.177.1 stores {auth,account} sessions, but its restore path may migrate
 * encrypted fields. We deliberately do not invoke it or discover users' login files.
 * Resource requests, optional envelopes and quota fallback order follow
 * ai-usage-board/src/vendors/workbuddy.ts (fetchUsage/extractResources/parseCycle*).
 * A short page (or a consistent TotalCount) terminates pagination. Full pages alone
 * need another request; cross-page overlap and bounded scans fail closed.
 * Equal-valued rows on the SAME page may be separate grants and are all counted.
 */
export declare function createAccountRefresher(options?: AccountRefresherOptions): () => Promise<AccountStatus>;
