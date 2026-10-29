import { type PluginConfig } from './config.ts';
export declare function settingsPath(): string;
/** Only non-secret UI settings are stored here. Invalid files are not silently replaced. */
export declare class SettingsStore {
    readonly config: PluginConfig;
    private saved;
    private readonly entry;
    readonly path: string;
    /** A diagnostic-only configuration keeps recovery routes available, never execution. */
    readonly loadError?: string;
    constructor(entry?: Record<string, unknown>, path?: string);
    /** Browser patches cannot change administrator-only settings or discovery metadata. */
    updateFromPanel(patch: unknown): PluginConfig;
    update(patch: unknown): PluginConfig;
}
