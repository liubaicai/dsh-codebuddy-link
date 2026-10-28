import { type PluginConfig } from './config.ts';
export declare function settingsPath(): string;
/** Only non-secret UI settings are stored here. Invalid files are not silently replaced. */
export declare class SettingsStore {
    readonly config: PluginConfig;
    private saved;
    private readonly entry;
    readonly path: string;
    constructor(entry?: Record<string, unknown>, path?: string);
    update(patch: unknown): PluginConfig;
}
