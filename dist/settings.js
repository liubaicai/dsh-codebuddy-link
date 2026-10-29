import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveConfig } from "./config.js";
const editable = new Set(['permissionMode', 'models', 'hiddenModels', 'defaultModel', 'tools', 'modelContext',
    'reasoningEffort', 'maxConcurrency', 'queueTimeoutMs', 'stallWarnMs', 'dangerouslySkipPermissions']);
/** Keys written by older plugin versions. They are dropped on load so saved
 *  settings keep working after the setting was removed; never editable again. */
const retired = new Set(['executionMode']);
export function settingsPath() {
    return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins', 'dsh-codebuddy-link', 'settings.json');
}
/** Only non-secret UI settings are stored here. Invalid files are not silently replaced. */
export class SettingsStore {
    config;
    saved;
    entry;
    path;
    /** A diagnostic-only configuration keeps recovery routes available, never execution. */
    loadError;
    constructor(entry = {}, path = settingsPath()) {
        this.entry = entry;
        this.path = path;
        this.saved = {};
        try {
            let saved = {};
            try {
                saved = JSON.parse(readFileSync(path, 'utf8'));
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
            this.saved = withoutRetired(validateKeys(saved));
            this.config = resolveConfig({ ...entry, ...this.saved });
        }
        catch {
            // Do not overwrite, silently discard unknown keys, or execute using fallback
            // permissions. A restart after external repair is the explicit recovery step.
            this.loadError = 'CodeBuddy settings could not be loaded. Provider and delegation are disabled. Repair the plugin settings.json file and restart DSH; the original file has not been changed.';
            this.config = resolveConfig({ enabled: false, askTool: false, permissionMode: 'dontAsk', tools: '', dangerouslySkipPermissions: false }, {});
        }
    }
    update(patch) {
        if (this.loadError)
            throw new Error(this.loadError);
        const updates = withoutRetired(validateKeys(patch));
        const saved = { ...this.saved, ...updates };
        const next = resolveConfig({ ...this.entry, ...saved });
        if (next.hiddenModels.includes(next.defaultModel))
            throw new Error('Default model must be enabled');
        if (!next.models.some(id => !next.hiddenModels.includes(id)))
            throw new Error('Enable at least one model');
        mkdirSync(dirname(this.path), { recursive: true });
        const tmp = this.path + '.' + randomUUID() + '.tmp';
        writeFileSync(tmp, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        renameSync(tmp, this.path);
        this.saved = saved;
        // Preserve identity so registered adapters and tools read live settings.
        Object.assign(this.config, next);
        return this.config;
    }
}
function validateKeys(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Settings must be an object');
    for (const key of Object.keys(value))
        if (!editable.has(key) && !retired.has(key))
            throw new Error(`Unsupported setting: ${key}`);
    return value;
}
function withoutRetired(value) {
    const next = {};
    for (const [key, entry] of Object.entries(value))
        if (!retired.has(key))
            next[key] = entry;
    return next;
}
//# sourceMappingURL=settings.js.map