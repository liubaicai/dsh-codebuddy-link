export const CODEBUDDY_EFFORTS = ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
export function isCodeBuddyEffort(value) {
    return typeof value === 'string' && CODEBUDDY_EFFORTS.includes(value);
}
export function resolveConfig(entry = {}, env = process.env) {
    const value = (key, variable, fallback) => entry[key] ?? env[variable] ?? fallback;
    const string = (key, variable, fallback = '') => {
        const v = value(key, variable, fallback);
        if (typeof v !== 'string')
            throw new Error(`${key} must be a string`);
        return v.trim();
    };
    const bool = (key, variable, fallback) => {
        const v = value(key, variable, fallback);
        if (v === true || v === 'true')
            return true;
        if (v === false || v === 'false')
            return false;
        throw new Error(`${key} must be true or false`);
    };
    const number = (key, variable, fallback) => {
        const v = Number(value(key, variable, fallback));
        if (!Number.isSafeInteger(v) || v <= 0)
            throw new Error(`${key} must be a positive integer`);
        return v;
    };
    const boundedInteger = (key, variable, fallback, min, max) => {
        const raw = value(key, variable, fallback);
        const v = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
        if (!Number.isSafeInteger(v) || v < min || v > max)
            throw new Error(`${key} must be an integer from ${min} to ${max}`);
        return v;
    };
    const reasoningEffort = string('reasoningEffort', 'DSH_CODEBUDDY_REASONING_EFFORT', 'auto');
    if (!isCodeBuddyEffort(reasoningEffort))
        throw new Error(`reasoningEffort must be ${CODEBUDDY_EFFORTS.join(', ')}`);
    const mode = string('permissionMode', 'DSH_CODEBUDDY_MODE', 'dontAsk');
    if (mode !== 'dontAsk' && mode !== 'plan' && mode !== 'acceptEdits')
        throw new Error('permissionMode must be dontAsk, plan or acceptEdits');
    const model = string('defaultModel', 'DSH_CODEBUDDY_DEFAULT_MODEL', 'default') || 'default';
    const rawModels = value('models', 'DSH_CODEBUDDY_MODELS', '');
    if (!Array.isArray(rawModels) && typeof rawModels !== 'string')
        throw new Error('models must be an array or comma-separated string');
    const models = Array.isArray(rawModels) ? rawModels : rawModels.split(',');
    const hidden = value('hiddenModels', 'DSH_CODEBUDDY_HIDDEN_MODELS', []);
    const hiddenModels = Array.isArray(hidden) ? hidden : typeof hidden === 'string' ? hidden.split(',').filter(Boolean) : null;
    if (!hiddenModels || hiddenModels.some(v => typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(v)))
        throw new Error('Invalid hiddenModels');
    const cleanModels = [...new Set(['default', model, ...models].map(v => {
            if (typeof v !== 'string')
                throw new Error('models must contain strings');
            return v.trim();
        }).filter(Boolean))];
    if (cleanModels.some(v => !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(v)))
        throw new Error('Invalid model id');
    const rawModelContext = value('modelContext', 'DSH_CODEBUDDY_MODEL_CONTEXT', {});
    const modelContextSource = typeof rawModelContext === 'string' ? JSON.parse(rawModelContext) : rawModelContext;
    if (!modelContextSource || typeof modelContextSource !== 'object' || Array.isArray(modelContextSource))
        throw new Error('modelContext must be an object');
    const modelContext = {};
    for (const [id, window] of Object.entries(modelContextSource)) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id))
            throw new Error('Invalid modelContext id');
        const size = Number(window);
        if (!Number.isSafeInteger(size) || size <= 0)
            throw new Error(`Invalid context window for ${id}`);
        modelContext[id] = size;
    }
    return {
        enabled: bool('enabled', 'DSH_CODEBUDDY_ENABLED', true),
        codebuddyBin: string('codebuddyBin', 'DSH_CODEBUDDY_BIN'),
        defaultModel: model, models: cleanModels, hiddenModels: [...new Set(hiddenModels)],
        workspaceRoot: string('workspaceRoot', 'DSH_CODEBUDDY_WORKSPACE_ROOT'),
        permissionMode: mode, tools: string('tools', 'DSH_CODEBUDDY_TOOLS'),
        executionMode: 'autonomous',
        dangerouslySkipPermissions: bool('dangerouslySkipPermissions', 'DSH_CODEBUDDY_DANGEROUSLY_SKIP_PERMISSIONS', false),
        timeoutMs: number('timeoutMs', 'DSH_CODEBUDDY_TIMEOUT_MS', 600000),
        reasoningEffort,
        maxConcurrency: boundedInteger('maxConcurrency', 'DSH_CODEBUDDY_MAX_CONCURRENCY', 2, 1, 16),
        queueTimeoutMs: boundedInteger('queueTimeoutMs', 'DSH_CODEBUDDY_QUEUE_TIMEOUT_MS', 600000, 1, 2147483647),
        stallWarnMs: boundedInteger('stallWarnMs', 'DSH_CODEBUDDY_STALL_WARN_MS', 90000, 0, 2147483647),
        contextWindow: number('contextWindow', 'DSH_CODEBUDDY_CONTEXT_WINDOW', 128000),
        modelContext,
        maxPromptChars: number('maxPromptChars', 'DSH_CODEBUDDY_MAX_PROMPT_CHARS', 1000000),
        askTool: bool('askTool', 'DSH_CODEBUDDY_ASK_TOOL', true),
    };
}
//# sourceMappingURL=config.js.map