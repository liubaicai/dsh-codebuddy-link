import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveConfig } from "./config.js";
const editable = new Set(['permissionMode', 'models', 'hiddenModels', 'defaultModel', 'tools', 'modelContext']);
export function settingsPath() {
    return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins', 'dsh-codebuddy-link', 'settings.json');
}
/** Only non-secret UI settings are stored here. Invalid files are not silently replaced. */
export class SettingsStore {
    config;
    saved;
    entry;
    path;
    constructor(entry = {}, path = settingsPath()) {
        this.entry = entry;
        this.path = path;
        let saved = {};
        try {
            saved = JSON.parse(readFileSync(path, 'utf8'));
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw new Error('Cannot read CodeBuddy settings; repair or remove the plugin settings file');
        }
        this.saved = validateKeys(saved);
        this.config = resolveConfig({ ...entry, ...this.saved });
    }
    update(patch) {
        const updates = validateKeys(patch);
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
        if (!editable.has(key))
            throw new Error(`Unsupported setting: ${key}`);
    return value;
}
//# sourceMappingURL=settings.js.map