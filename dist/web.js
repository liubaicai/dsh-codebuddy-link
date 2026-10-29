import { isModelIdentifier } from "./metadata.js";
import { isRequestModelIdentifier } from "./model-id.js";
import { isCodeBuddyEffort } from "./config.js";
export function registerSettingsRoutes(server, store, notify, refreshAccount = async () => ({ status: 'unavailable', message: '账户积分接口尚不可用；请在 CodeBuddy / WorkBuddy 客户端查看。' }), auth, refreshModels, readRuns = () => [], accounts) {
    let account = { status: 'unavailable', message: '点击刷新查询账户积分。' };
    let pending;
    let generation = 0;
    let catalog = [];
    let modelPending;
    let modelMessage = '';
    const resetAccount = () => { generation++; pending = undefined; modelPending = undefined; catalog = []; modelMessage = ''; accounts?.changed(); notify(); account = { status: 'unavailable', message: '账户已更新，请刷新积分。' }; };
    const snapshot = async () => ({
        ...(store.loadError ? { settingsError: store.loadError } : {}),
        modelMessage,
        ...(accounts ? { accountPool: accounts.snapshot() } : {}),
        auth: auth ? await auth.status() : { configured: false },
        config: { enabled: store.config.enabled, permissionMode: store.config.permissionMode, models: store.config.models,
            hiddenModels: store.config.hiddenModels, defaultModel: store.config.defaultModel, tools: store.config.tools,
            reasoningEffort: store.config.reasoningEffort, maxConcurrency: store.config.maxConcurrency,
            queueTimeoutMs: store.config.queueTimeoutMs, stallWarnMs: store.config.stallWarnMs,
            dangerouslySkipPermissions: store.config.dangerouslySkipPermissions },
        runs: publicRuns(readRuns()),
        account, catalogModels: [...new Map([...catalog, ...store.config.models.filter(id => !catalog.some(m => m.id === id)).map(id => ({ id, name: id === 'default' ? 'CodeBuddy CLI 默认模型' : id }))].map(m => [m.id, m])).values()],
    });
    const disposers = [];
    for (const action of ['status', 'config', 'refresh', ...(refreshModels ? ['models'] : []), ...(auth ? ['auth/start', 'auth/poll', 'auth/cancel'] : []), ...(accounts ? ['account/update', 'account/remove', 'account/select', 'account/refresh'] : [])]) {
        const dispose = server.register({ kind: 'exact', path: `/plugins/codebuddy-link/${action}`, handler: (req, res) => {
                void (async () => {
                    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
                    const method = action === 'status' ? 'GET' : 'POST';
                    if (req.method !== method) {
                        send(405, { error: `${method} only` });
                        return;
                    }
                    // Host supplies authentication. Also reject cross-origin browser requests, even on loopback.
                    const origin = req.headers.origin;
                    if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && !sameHost(origin, req.headers.host))) {
                        send(403, { error: 'Cross-origin request denied' });
                        return;
                    }
                    try {
                        if (action !== 'status') {
                            if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
                                send(415, { error: 'JSON required' });
                                return;
                            }
                            const body = await readJson(req);
                            if (action.startsWith('auth/') && auth) {
                                if (!body || typeof body !== 'object' || Array.isArray(body))
                                    throw new Error('Invalid body');
                                const input = body;
                                if (action === 'auth/start') {
                                    if (Object.keys(input).some(key => key !== 'accountId') || (input.accountId !== undefined && typeof input.accountId !== 'string'))
                                        throw new Error('Invalid account');
                                    send(200, await auth.start(input.accountId));
                                }
                                else {
                                    if (typeof input.flowId !== 'string' || input.flowId.length > 128)
                                        throw new Error('Invalid flow');
                                    if (action === 'auth/cancel') {
                                        await auth.cancel(input.flowId);
                                        send(200, { status: 'cancelled' });
                                    }
                                    else {
                                        const result = await auth.poll(input.flowId);
                                        if (result && typeof result === 'object' && 'status' in result && result.status === 'ok')
                                            resetAccount();
                                        send(200, result);
                                    }
                                }
                                return;
                            }
                            if (action.startsWith('account/') && accounts) {
                                if (!body || typeof body !== 'object' || Array.isArray(body))
                                    throw new Error('Invalid account action');
                                const input = body;
                                const allowed = action === 'account/select' ? ['mode', 'accountId'] : action === 'account/update' ? ['id', 'name', 'enabled'] : ['id'];
                                if (Object.keys(input).some(key => !allowed.includes(key)))
                                    throw new Error('Invalid account action');
                                if (action === 'account/select') {
                                    if ((input.mode !== 'fixed' && input.mode !== 'pool') || (input.accountId !== undefined && typeof input.accountId !== 'string'))
                                        throw new Error('Invalid account selection');
                                    await accounts.configure({ mode: input.mode, ...(input.accountId === undefined ? {} : { accountId: input.accountId }) });
                                }
                                else {
                                    if (typeof input.id !== 'string' || input.id.length > 128)
                                        throw new Error('Invalid account');
                                    if (action === 'account/update') {
                                        if ((input.name !== undefined && typeof input.name !== 'string') || (input.enabled !== undefined && typeof input.enabled !== 'boolean'))
                                            throw new Error('Invalid account update');
                                        await accounts.update(input.id, { ...(input.name === undefined ? {} : { name: input.name }), ...(input.enabled === undefined ? {} : { enabled: input.enabled }) });
                                    }
                                    else if (action === 'account/remove')
                                        await accounts.remove(input.id);
                                    else
                                        await accounts.refresh(input.id);
                                }
                                notify();
                                send(200, await snapshot());
                                return;
                            }
                            if (action === 'config') {
                                store.update(body);
                                notify();
                            }
                            else if (action === 'models' && refreshModels) {
                                const version = generation;
                                modelPending ??= refreshModels().then(value => {
                                    if (version !== generation)
                                        return;
                                    catalog = value.models;
                                    modelMessage = value.message ?? '';
                                    // Persist discovered context windows as plain metadata so the adapter
                                    // can advertise honest per-model limits; never fails the discovery.
                                    const windows = {};
                                    for (const model of value.models)
                                        if (Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0)
                                            windows[model.id] = model.contextWindow;
                                    if (Object.keys(windows).length) {
                                        try {
                                            store.update({ modelContext: { ...store.config.modelContext, ...windows } });
                                        }
                                        catch { /* metadata only */ }
                                    }
                                }).catch(() => { throw new Error('模型列表获取失败，请检查网络后重试。'); }).finally(() => { if (version === generation)
                                    modelPending = undefined; });
                                await modelPending;
                            }
                            else {
                                const version = generation;
                                pending ??= Promise.resolve().then(refreshAccount).then(value => { if (generation === version)
                                    account = value; }).catch(() => { if (generation === version)
                                    account = { status: 'error', message: '账户积分查询失败，请检查登录和网络。' }; }).finally(() => { if (generation === version)
                                    pending = undefined; });
                                await pending;
                            }
                        }
                        send(200, await snapshot());
                    }
                    catch (error) {
                        send(400, { error: action.startsWith('auth/') || action.startsWith('account/') ? '账户操作失败，请检查账户选择与授权状态。' : error instanceof Error ? error.message : 'Invalid request' });
                    }
                })();
            } });
        if (typeof dispose === 'function')
            disposers.push(dispose);
    }
    return () => { generation++; auth?.cancelAll(); for (const dispose of disposers.reverse())
        dispose(); };
}
// A runtime snapshot is deliberately a metadata-only boundary, never a raw runner object.
function publicRuns(values) {
    if (!Array.isArray(values))
        return [];
    const recent = [];
    for (const value of values) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            continue;
        const run = value;
        if (typeof run.id !== 'string' || !['model', 'ask'].includes(String(run.source))
            || !['queued', 'starting', 'waiting', 'responding', 'completed', 'failed', 'cancelled'].includes(String(run.state))
            || typeof run.requestedModel !== 'string' || typeof run.requestedEffort !== 'string'
            || typeof run.queuedAt !== 'number' || !Number.isFinite(run.queuedAt))
            continue;
        const clean = { id: run.id, source: run.source, state: run.state,
            requestedModel: isRequestModelIdentifier(run.requestedModel) ? run.requestedModel : 'unknown', requestedEffort: isCodeBuddyEffort(run.requestedEffort) ? run.requestedEffort : 'auto', queuedAt: run.queuedAt,
            contextOverrideSent: false, reasoningConfirmed: false, warning: run.warning === true,
            queuePosition: Number.isSafeInteger(run.queuePosition) && Number(run.queuePosition) >= 0 ? run.queuePosition : 0 };
        if (typeof run.accountId === 'string' && /^[a-f0-9]{32}$/.test(run.accountId))
            clean.accountId = run.accountId;
        if (typeof run.accountName === 'string' && run.accountName.length <= 100 && !/[\x00-\x1f\x7f]/.test(run.accountName))
            clean.accountName = run.accountName;
        if (isModelIdentifier(run.returnedModel))
            clean.returnedModel = run.returnedModel;
        if (run.contextSource === 'model' || run.contextSource === 'fallback')
            clean.contextSource = run.contextSource;
        for (const key of ['contextWindow', 'startedAt', 'lastProgressAt', 'endedAt', 'totalCredits', 'totalCostUsd']) {
            if (typeof run[key] === 'number' && Number.isFinite(run[key]) && run[key] >= 0)
                clean[key] = run[key];
        }
        if (['timeout', 'queue-timeout', 'aborted', 'error'].includes(String(run.failure)))
            clean.failure = run.failure;
        recent.push(clean);
        recent.sort((a, b) => Number(b.queuedAt) - Number(a.queuedAt));
        if (recent.length > 5)
            recent.pop();
    }
    return recent;
}
function sameHost(origin, host) {
    try {
        const url = new URL(origin);
        return ['http:', 'https:'].includes(url.protocol) && url.host === host;
    }
    catch {
        return false;
    }
}
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;
        if (size > 32768)
            throw new Error('Request body too large');
        chunks.push(data);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new Error('Invalid JSON');
    }
}
//# sourceMappingURL=web.js.map