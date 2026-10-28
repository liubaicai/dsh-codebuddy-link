window.__ModuleLoader__.load({ id: "dsh-codebuddy-link", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.name = void 0;
exports.apply = apply;
const { createElement, useState, useEffect, useRef } = require('react');
const controlStyle = { font: 'inherit', fontSize: '13px', minHeight: '36px', boxSizing: 'border-box', border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', borderRadius: '6px', padding: '8px 12px', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'var(--dsw-alias-label-primary, inherit)' };
function h(type, props, ...children) {
    const styles = {
        button: { ...controlStyle, cursor: props?.disabled ? 'not-allowed' : 'pointer', opacity: props?.disabled ? 0.5 : 1, fontWeight: 500 },
        select: { ...controlStyle, width: '100%' },
        input: props?.type === 'checkbox' ? { accentColor: 'var(--accent-9, #3e63dd)', width: '16px', height: '16px', verticalAlign: 'middle', marginRight: '8px' } : { ...controlStyle, width: '100%' },
        textarea: { ...controlStyle, width: '100%' },
        h2: { fontSize: '18px', fontWeight: 600, margin: '0 0 12px' },
        h3: { fontSize: '14px', fontWeight: 600, margin: '0 0 12px' },
        p: { margin: '10px 0', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, inherit)' },
        legend: { fontSize: '14px', fontWeight: 600, padding: '0 6px' },
        a: { color: 'var(--dsw-alias-state-business-primary, #5b8def)', display: 'inline-block', margin: '12px 0' },
    };
    return createElement(type, { ...props, style: { ...(typeof type === 'string' ? styles[type] : {}), ...(props?.role === 'alert' ? { color: 'var(--red-11, #ce2c31)' } : {}), ...(props?.style ?? {}) } }, ...children);
}
exports.name = 'dsh-codebuddy-link-client';
exports.inject = ['slots'];
const modes = ['dontAsk', 'plan', 'acceptEdits'];
// The classic-script entry cannot import server modules.
const efforts = ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
const bounded = (value, min, max) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value) => Array.isArray(value) && value.every(item => typeof item === 'string');
function parseStatus(value) {
    if (!isRecord(value) || !isRecord(value.config) || !isRecord(value.account))
        throw new Error('服务端状态格式无效');
    const c = value.config;
    if (typeof c.enabled !== 'boolean' || typeof c.permissionMode !== 'string' || !strings(c.models) || !strings(c.hiddenModels)
        || typeof c.defaultModel !== 'string' || typeof c.tools !== 'string' || !Array.isArray(value.catalogModels)
        || !value.catalogModels.every(model => isRecord(model) && typeof model.id === 'string' && typeof model.name === 'string')
        || !['ok', 'unavailable', 'auth-required', 'error'].includes(String(value.account.status)))
        throw new Error('服务端状态格式无效');
    const reasoningEffort = c.reasoningEffort ?? 'auto';
    const maxConcurrency = c.maxConcurrency ?? 2;
    const queueTimeoutMs = c.queueTimeoutMs ?? 600000;
    const stallWarnMs = c.stallWarnMs ?? 90000;
    if (typeof reasoningEffort !== 'string' || !efforts.includes(reasoningEffort) || !bounded(maxConcurrency, 1, 16)
        || !bounded(queueTimeoutMs, 1, 2147483647) || !bounded(stallWarnMs, 0, 2147483647))
        throw new Error('服务端状态格式无效');
    return { config: { enabled: c.enabled, permissionMode: c.permissionMode, models: c.models, hiddenModels: c.hiddenModels,
            defaultModel: c.defaultModel, tools: c.tools, reasoningEffort, maxConcurrency, queueTimeoutMs, stallWarnMs },
        account: value.account,
        catalogModels: value.catalogModels.map(model => ({ id: model.id, name: model.name })),
        modelMessage: typeof value.modelMessage === 'string' ? value.modelMessage : undefined,
        auth: { configured: isRecord(value.auth) && value.auth.configured === true }, runs: parseRuns(value.runs) };
}
// Kept local because the classic browser entry cannot import server modules.
function isModelIdentifier(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.exec(value)?.[0] === value
        && !value.includes(':/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function parseRuns(value) {
    if (!Array.isArray(value))
        return [];
    const runs = [];
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.id !== 'string' || !['model', 'ask'].includes(String(entry.source))
            || !['queued', 'starting', 'waiting', 'responding', 'completed', 'failed', 'cancelled'].includes(String(entry.state))
            || typeof entry.requestedModel !== 'string' || typeof entry.requestedEffort !== 'string'
            || !bounded(entry.queuedAt, 0, Number.MAX_SAFE_INTEGER))
            continue;
        const run = { id: entry.id, source: entry.source, state: entry.state,
            requestedModel: isModelIdentifier(entry.requestedModel) ? entry.requestedModel : 'unknown', requestedEffort: efforts.includes(entry.requestedEffort) ? entry.requestedEffort : 'auto', queuedAt: entry.queuedAt,
            contextOverrideSent: false, reasoningConfirmed: false, warning: entry.warning === true,
            queuePosition: bounded(entry.queuePosition, 0, Number.MAX_SAFE_INTEGER) ? entry.queuePosition : 0 };
        if (isModelIdentifier(entry.returnedModel))
            run.returnedModel = entry.returnedModel;
        if (entry.contextSource === 'model' || entry.contextSource === 'fallback')
            run.contextSource = entry.contextSource;
        for (const key of ['contextWindow', 'startedAt', 'lastProgressAt', 'endedAt', 'totalCredits', 'totalCostUsd']) {
            if (typeof entry[key] === 'number' && Number.isFinite(entry[key]) && entry[key] >= 0)
                run[key] = entry[key];
        }
        if (['timeout', 'queue-timeout', 'aborted', 'error'].includes(String(entry.failure)))
            run.failure = entry.failure;
        runs.push(run);
    }
    // Latest five total, regardless of state or server ordering; retain only sanitized fields.
    return runs.sort((a, b) => b.queuedAt - a.queuedAt).slice(0, 5);
}
function officialVerificationUri(value) {
    if (typeof value !== 'string')
        return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'www.codebuddy.cn' && !url.username && !url.password
            && (!url.port || url.port === '443') ? url.href : null;
    }
    catch {
        return null;
    }
}
// Auth endpoints do not return a Status. Whitelist their fields, never display credentials
// or raw response/network errors (which can include submitted JSON).
async function requestAuth(action, body) {
    let response;
    try {
        response = await fetch(`/plugins/codebuddy-link/auth/${action}`, {
            method: 'POST', credentials: 'same-origin', mode: 'same-origin', signal: AbortSignal.timeout(20_000),
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
    }
    catch {
        throw new Error('登录请求失败，请重试');
    }
    if (!response.ok)
        throw new Error(`登录请求失败（HTTP ${response.status}）`.slice(0, 300));
    let value;
    try {
        value = await response.json();
    }
    catch {
        throw new Error('登录响应格式无效');
    }
    if (!isRecord(value))
        throw new Error('登录响应格式无效');
    if (action === 'start' && typeof value.flowId === 'string' && value.flowId.length > 0
        && typeof value.verificationUri === 'string' && Number.isInteger(value.expiresIn) && Number(value.expiresIn) > 0 && Number(value.expiresIn) <= 600 && value.interval === 2) {
        return { flowId: value.flowId, verificationUri: officialVerificationUri(value.verificationUri), expiresIn: value.expiresIn };
    }
    if ((action === 'import' || action === 'clear') && typeof value.configured === 'boolean'
        && (action !== 'clear' || value.configured === false))
        return { configured: value.configured };
    if (action === 'poll' && (value.status === 'pending' || value.status === 'ok'))
        return { status: value.status };
    if (action === 'cancel' && value.status === 'cancelled')
        return { status: value.status };
    throw new Error('登录响应格式无效');
}
async function request(action, body) {
    const response = await fetch(`/plugins/codebuddy-link/${action}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        mode: 'same-origin',
        signal: AbortSignal.timeout(20_000),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
        let detail = '';
        try {
            const body = await response.json();
            if (isRecord(body) && typeof body.error === 'string')
                detail = body.error.slice(0, 300);
        }
        catch { /* Non-JSON errors must not replace the HTTP status. */ }
        throw new Error(`请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
    }
    return parseStatus(await response.json());
}
const box = { padding: '16px', border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', borderRadius: '8px', marginBottom: '16px' };
const authControl = { fontSize: '13px', border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', borderRadius: '6px', padding: '8px', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'var(--dsw-alias-label-primary, inherit)' };
const row = { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' };
const field = { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' };
const text = (value) => typeof value === 'string' && value.trim() ? value : '未知';
const amount = (value) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '未知';
function renderRun(run) {
    const labels = { queued: '排队中', starting: '启动中', waiting: '等待响应', responding: '响应中', completed: '已完成', failed: '失败', cancelled: '已取消' };
    const failures = { 'timeout': '执行超时', 'queue-timeout': '排队超时', 'aborted': '已中止', 'error': '执行失败' };
    const time = (value) => value === undefined ? '未知' : new Date(value).toLocaleTimeString();
    return h('article', { key: run.id, style: { borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', padding: '10px 0', overflowWrap: 'anywhere' } }, h('div', { style: row }, h('strong', null, labels[run.state]), h('span', null, run.source === 'model' ? '模型调用' : '独立委派'), run.state === 'queued' ? h('span', null, `队列位置：${run.queuePosition}`) : null), h('p', null, `请求模型：${text(run.requestedModel)}；返回模型：${text(run.returnedModel)}`), h('p', null, `请求推理强度：${text(run.requestedEffort)}（服务端未确认）`), h('p', null, `DSH 上下文预算：${run.contextWindow ?? '未知'}；来源：${run.contextSource === 'model' ? '模型元数据' : run.contextSource === 'fallback' ? '回退配置' : '未知'}；未向 CLI 覆盖上下文限制`), h('p', null, `积分：${amount(run.totalCredits)}；费用（USD）：${amount(run.totalCostUsd)}`), h('p', null, `入队：${time(run.queuedAt)}；开始：${time(run.startedAt)}；进展：${time(run.lastProgressAt)}；结束：${time(run.endedAt)}`), run.warning ? h('p', { role: 'status' }, '长时间无进展，仍在等待；这不代表调用失败。') : null, run.failure ? h('p', null, failures[run.failure]) : null);
}
function SettingsPanel() {
    const [status, setStatus] = useState(null);
    const [draft, setDraft] = useState(null);
    const [customModel, setCustomModel] = useState('');
    const [busy, setBusy] = useState('加载中');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const active = useRef(false);
    const sequence = useRef(0);
    const pending = useRef(false);
    const [authContent, setAuthContent] = useState('');
    const [authFlow, setAuthFlow] = useState(null);
    const [authBusy, setAuthBusy] = useState(false);
    const [authError, setAuthError] = useState('');
    const [authNotice, setAuthNotice] = useState('');
    const authPending = useRef(false);
    const authSequence = useRef(0);
    // The caller holds its in-flight lock for the entire chain. Check its generation
    // after each await, before updating state or starting another external request.
    async function refreshAccount(current) {
        const account = await request('refresh', {});
        if (!current())
            return;
        setStatus(account);
        if (account.account.status !== 'ok')
            return;
        const models = await request('models', {});
        if (current())
            setStatus(models);
    }
    async function authenticate(action) {
        if (!active.current || authPending.current || pending.current || !status)
            return;
        if ((action === 'poll' || action === 'cancel') && !authFlow)
            return;
        authPending.current = true;
        const ticket = ++authSequence.current;
        setAuthBusy(true);
        setAuthError('');
        setAuthNotice('');
        const current = () => active.current && ticket === authSequence.current;
        try {
            const result = await requestAuth(action, action === 'import' ? { content: authContent }
                : action === 'poll' || action === 'cancel' ? { flowId: authFlow.flowId } : {});
            if (!current())
                return;
            if (action === 'start') {
                setAuthFlow(result);
                setAuthNotice('请打开官方授权页面完成登录，然后手动检查登录结果。链接有效期为 10 分钟。');
            }
            else if (action === 'cancel') {
                setAuthFlow(null);
                setAuthContent('');
                setAuthNotice('登录已取消，已有凭据保持不变。');
            }
            else if (action === 'poll' && result.status === 'pending') {
                setAuthNotice('尚未完成登录，请在官方页面授权后再次检查。');
            }
            else {
                setAuthContent('');
                setAuthFlow(null);
                setAuthNotice(action === 'clear' ? '积分查询凭据已清除。' : '登录信息已更新。');
                if (typeof result.configured === 'boolean')
                    setStatus(previous => previous
                        ? { ...previous, auth: { configured: result.configured } } : previous);
                // Deliberately bypass load(): a successful login must not replace the model draft.
                try {
                    if (action === 'clear') {
                        const refreshed = await request('status');
                        if (current())
                            setStatus(refreshed);
                    }
                    else {
                        await refreshAccount(current);
                    }
                }
                catch {
                    if (current())
                        setAuthError('登录操作已完成，但状态刷新失败，请手动刷新账户。');
                }
            }
        }
        catch (cause) {
            if (current())
                setAuthError(cause instanceof Error ? cause.message.slice(0, 300) : '登录请求失败，请重试');
        }
        finally {
            if (ticket === authSequence.current) {
                authPending.current = false;
                if (active.current)
                    setAuthBusy(false);
            }
        }
    }
    async function load(action, config, automatic = false) {
        if (!active.current || pending.current || authPending.current)
            return;
        pending.current = true;
        const ticket = ++sequence.current;
        if (!automatic) {
            setBusy(action === 'config' ? '保存中' : action === 'refresh' ? '刷新中' : '加载中');
            setError('');
            setNotice('');
        }
        const current = () => active.current && ticket === sequence.current;
        try {
            if (action !== 'refresh') {
                const endpoint = action === 'initial' ? 'status' : action;
                const result = await request(endpoint, endpoint === 'status' ? undefined : endpoint === 'models' ? {} : {
                    permissionMode: config.permissionMode, models: config.models, hiddenModels: config.hiddenModels,
                    defaultModel: config.defaultModel, tools: config.tools, reasoningEffort: config.reasoningEffort,
                    maxConcurrency: config.maxConcurrency, queueTimeoutMs: config.queueTimeoutMs, stallWarnMs: config.stallWarnMs,
                });
                if (!current())
                    return;
                setStatus(result);
                // Only a successful save replaces an existing draft, never background discovery.
                if (action === 'config')
                    setDraft(result.config);
                else
                    setDraft(previous => previous ?? result.config);
            }
            if (action === 'initial' || action === 'refresh')
                await refreshAccount(current);
            if (!current())
                return;
            if (!automatic)
                setNotice(action === 'config' ? '设置已保存' : action === 'refresh' ? '账户状态已刷新' : '');
        }
        catch (cause) {
            if (!automatic && active.current && ticket === sequence.current)
                setError(cause instanceof Error ? cause.message : '请求失败，请重试');
        }
        finally {
            if (ticket === sequence.current) {
                pending.current = false;
                if (active.current)
                    setBusy('');
            }
        }
    }
    useEffect(() => {
        active.current = true;
        void load('initial');
        const timer = setInterval(() => { void load('status', undefined, true); }, 2000);
        return () => { clearInterval(timer); active.current = false; ++sequence.current; ++authSequence.current; pending.current = false; authPending.current = false; };
    }, []);
    const update = (patch) => { setDraft(previous => previous ? { ...previous, ...patch } : previous); setNotice(''); };
    const models = new Map();
    for (const model of status?.catalogModels ?? [])
        models.set(model.id, model.name);
    for (const id of [...(draft?.models ?? []), ...(draft?.hiddenModels ?? []), ...(draft?.defaultModel ? [draft.defaultModel] : [])]) {
        if (!models.has(id))
            models.set(id, id);
    }
    const enabledModels = [...models.keys()].filter(id => draft?.models.includes(id) && !draft.hiddenModels.includes(id));
    const validDefault = !!draft?.defaultModel && enabledModels.includes(draft.defaultModel);
    const validMode = !!draft && modes.includes(draft.permissionMode);
    const validRuntime = !!draft && efforts.includes(draft.reasoningEffort) && bounded(draft.maxConcurrency, 1, 16)
        && bounded(draft.queueTimeoutMs, 1, 2147483647) && bounded(draft.stallWarnMs, 0, 2147483647);
    const account = status?.account;
    const accountLabels = { ok: '可用', unavailable: '暂不可用', 'auth-required': '需要登录', error: '查询失败' };
    return h('section', { 'aria-label': 'CodeBuddy 设置', style: { maxWidth: '760px', width: '100%', boxSizing: 'border-box', padding: '20px', fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-primary, inherit)' } }, h('h2', null, 'CodeBuddy 设置'), h('p', null, status ? `插件状态：${status.config.enabled ? '已启用' : '未启用'}` : '正在读取插件状态'), h('div', { role: 'status', 'aria-live': 'polite' }, busy ? `${busy}…` : notice), error ? h('div', { role: 'alert', style: { margin: '12px 0' } }, error, !status ? h('button', { type: 'button', disabled: !!busy, onClick: () => void load('initial') }, '重试加载') : null) : null, h('section', { style: { ...box, fontSize: '13px' }, 'aria-label': '账户登录' }, h('h3', null, '账户登录'), h('p', null, '用于积分与模型列表查询，不改变 CodeBuddy CLI 登录。'), h('p', null, `积分查询凭据：${status?.auth.configured ? '已配置' : '未配置'}`), h('div', { role: 'status', 'aria-live': 'polite' }, authBusy ? '登录操作中…' : authNotice), authError ? h('p', { role: 'alert' }, authError) : null, h('div', { style: row }, h('button', { type: 'button', style: authControl, disabled: !!busy || authBusy || !status || !!authFlow,
        onClick: () => void authenticate('start') }, '使用 OAuth 登录'), h('button', { type: 'button', style: authControl, disabled: !!busy || authBusy || !status?.auth.configured || !!authFlow,
        onClick: () => void authenticate('clear') }, '清除积分查询凭据')), authFlow ? h('div', null, authFlow.verificationUri ? h('a', { href: authFlow.verificationUri, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: '13px' } }, '打开 CodeBuddy 官方授权页面')
        : h('p', { role: 'alert' }, '授权链接不安全，已禁止打开。请取消后重试。'), h('div', { style: row }, h('button', { type: 'button', style: authControl, disabled: authBusy || !!busy, onClick: () => void authenticate('poll') }, '检查登录结果'), h('button', { type: 'button', style: authControl, disabled: authBusy || !!busy, onClick: () => void authenticate('cancel') }, '取消登录'))) : null, h('label', { style: { ...field, marginTop: '14px' } }, '导入登录 JSON', h('textarea', { value: authContent, rows: 4, autoComplete: 'off', spellCheck: false,
        disabled: authBusy || !!authFlow, style: { ...authControl, resize: 'vertical' },
        placeholder: '粘贴登录 JSON，仅提交到本插件；成功或取消后清空',
        onChange: (event) => setAuthContent(event.target.value) })), h('div', { style: row }, h('button', { type: 'button', style: authControl, disabled: !!busy || authBusy || !status || !!authFlow || !authContent.trim(),
        onClick: () => void authenticate('import') }, '导入登录信息'), h('button', { type: 'button', style: authControl, disabled: authBusy || !!authFlow || !authContent,
        onClick: () => { setAuthContent(''); setAuthError(''); setAuthNotice('已取消导入。'); } }, '取消导入'))), h('section', { style: box, 'aria-label': '账户积分' }, h('div', { style: row }, h('h3', { style: { margin: 0 } }, '账户与积分'), h('button', { type: 'button', disabled: !!busy || authBusy || !status, onClick: () => void load('refresh') }, '刷新账户')), h('p', null, `账户状态：${account ? accountLabels[account.status] : '未知'}`), account?.message ? h('p', null, text(account.message)) : null, h('div', { style: row }, h('span', null, `剩余：${amount(account?.remaining)}`), h('span', null, `总额：${amount(account?.total)}`), h('span', null, `已用：${amount(account?.used)}`)), h('p', null, `单位：${text(account?.unit)}；更新时间：${text(account?.updatedAt)}`), h('p', null, `来源：${text(account?.source)}`), h('p', null, '是否与 WorkBuddy 共享账户或积分，以接口返回为准。缺失字段显示“未知”，不推算余额。进入设置、手动刷新或登录成功后查询账户；账户可用时自动获取模型列表，不自动轮询外部服务。')), draft ? h('fieldset', { disabled: !!busy, style: { ...box, minWidth: 0 } }, h('legend', null, '模型与独立委派设置'), h('label', { style: field }, '权限模式', h('select', { value: draft.permissionMode, onChange: (event) => update({ permissionMode: event.target.value }) }, !validMode ? h('option', { value: draft.permissionMode, disabled: true }, `未知模式：${draft.permissionMode}`) : null, h('option', { value: 'dontAsk' }, 'dontAsk — 不询问'), h('option', { value: 'plan' }, 'plan — 规划模式'), h('option', { value: 'acceptEdits' }, 'acceptEdits — 接受编辑'))), h('p', null, '权限模式仅对独立委派 CodeBuddy 工具生效；provider 工具权限仍由 DSH 管理。'), h('div', { style: row }, h('h3', { style: { margin: 0 } }, '启用模型'), h('button', { type: 'button', disabled: !!busy || authBusy, onClick: () => void load('models') }, '获取模型列表')), h('p', null, status?.modelMessage || '获取列表后勾选模型，选择默认模型并保存。'), ...[...models].map(([id, label]) => h('label', { key: id, style: { display: 'block', marginBottom: '8px', overflowWrap: 'anywhere' } }, h('input', { type: 'checkbox', checked: enabledModels.includes(id),
        onChange: (event) => update({
            models: event.target.checked ? [...new Set([...draft.models, id])] : draft.models,
            hiddenModels: event.target.checked ? draft.hiddenModels.filter(hidden => hidden !== id) : [...new Set([...draft.hiddenModels, id])],
            defaultModel: !event.target.checked && draft.defaultModel === id ? enabledModels.find(model => model !== id) ?? '' : draft.defaultModel,
        }) }), ` ${label}${label === id ? '' : `（${id}）`}`)), h('label', { style: field }, '默认模型', h('select', { value: draft.defaultModel, onChange: (event) => update({ defaultModel: event.target.value }) }, h('option', { value: '', disabled: true }, '请选择默认模型'), !validDefault && draft.defaultModel ? h('option', { value: draft.defaultModel, disabled: true }, `${draft.defaultModel}（已禁用，请重选）`) : null, ...enabledModels.map(id => h('option', { key: id, value: id }, models.get(id))))), h('details', { style: { margin: '16px 0' } }, h('summary', { style: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, inherit)' } }, '高级设置：手动添加模型'), h('label', { style: field }, '自定义模型 ID', h('input', { type: 'text', value: customModel, placeholder: '输入精确的模型 ID',
        onChange: (event) => setCustomModel(event.target.value) })), h('button', { type: 'button', disabled: !customModel.trim(), onClick: () => {
            const id = customModel.trim();
            if (!id)
                return;
            update({ models: [...new Set([...draft.models, id])], hiddenModels: draft.hiddenModels.filter(hidden => hidden !== id) });
            setCustomModel('');
        } }, '添加并启用模型')), h('p', null, '勾选项用于显示模型；自定义 ID 的可用性由 CodeBuddy 服务端决定。'), h('label', { style: field }, '默认推理强度', h('select', { value: draft.reasoningEffort,
        onChange: (event) => update({ reasoningEffort: event.target.value }) }, ...efforts.map(effort => h('option', { key: effort, value: effort }, effort)))), h('p', null, 'auto 不发送推理强度参数；其他值仅表示请求，不代表服务端已确认。'), ...[
        ['maxConcurrency', '最大并发数', 1, 16],
        ['queueTimeoutMs', '排队等待上限（毫秒）', 1, 2147483647],
        ['stallWarnMs', '无进展提醒（毫秒，0 关闭）', 0, 2147483647],
    ].map(([key, label, min, max]) => h('label', { key, style: field }, label, h('input', { type: 'number', min, max, step: 1, value: Number.isNaN(draft[key]) ? '' : draft[key],
        onChange: (event) => update({ [key]: event.target.value.trim() === '' ? NaN : Number(event.target.value) }) }))), h('p', { role: 'note', style: { color: 'var(--dsw-alias-label-primary, inherit)', background: 'var(--dsw-alias-bg-layer-1, transparent)', border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', padding: '12px', borderRadius: '6px' } }, '警告：独立委派工具启用后不受DSH文件沙箱约束，默认留空。'), h('label', { style: field }, '独立委派工具配置（tools）', h('input', { type: 'text', value: draft.tools,
        onChange: (event) => update({ tools: event.target.value }) })), !validDefault || !validMode ? h('p', { role: 'alert' }, '请选择有效的权限模式与已启用的默认模型。') : null, !validRuntime ? h('p', { role: 'alert' }, '请检查推理强度、并发数与等待时间范围；时间必须为整数。') : null, h('button', { type: 'button', disabled: !!busy || authBusy || !validDefault || !validMode || !validRuntime, onClick: () => void load('config', draft) }, '保存设置')) : null, h('section', { style: box, 'aria-label': '运行记录' }, h('h3', null, '运行记录'), h('p', null, '仅当前进程内存，按入队时间显示最近 5 条运行记录（包括进行中与已结束调用，合计最多 5 条）；此面板打开时每 2 秒刷新状态。不会保存提示词、原始输出或错误详情。'), h('div', { style: { maxHeight: '420px', overflowY: 'auto' } }, ...(status?.runs.length ? status.runs.map(renderRun) : [h('p', null, '暂无运行记录')]))));
}
function apply(ctx) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'codebuddy-link', order: 20, label: 'CodeBuddy' }, SettingsPanel));
    const pluginPanel = (props) => isRecord(props) && props.view === 'summary' ? null : h(SettingsPanel);
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-codebuddy-link' }, pluginPanel));
    ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-codebuddy-link#codebuddy-link' }, pluginPanel));
}

return module.exports;
} });
