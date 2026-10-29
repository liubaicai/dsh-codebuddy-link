window.__ModuleLoader__.load({ id: "dsh-codebuddy-link", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.name = void 0;
exports.apply = apply;
const { createElement, useState, useEffect, useRef } = require('react');
const border = '0.5px solid var(--dsw-alias-border-l2, var(--gray-6, rgba(128,128,128,0.35)))';
const foreground = 'var(--dsw-alias-label-primary, var(--gray-12, inherit))';
const secondary = 'var(--dsw-alias-label-secondary, var(--gray-11, inherit))';
const surface = 'var(--dsw-alias-bg-layer-1, var(--gray-2, transparent))';
const accent = 'var(--dsw-alias-state-business-primary, var(--accent-9, #3e63dd))';
const controlStyle = { font: 'inherit', fontSize: '13px', minHeight: '30px', boxSizing: 'border-box', border, borderRadius: '6px', padding: '4px 9px', background: surface, color: foreground };
function h(type, props, ...children) {
    const styles = {
        button: { ...controlStyle, cursor: props?.disabled ? 'not-allowed' : 'pointer', opacity: props?.disabled ? 0.5 : 1, fontWeight: 500 },
        select: { ...controlStyle, width: '100%' },
        input: props?.type === 'checkbox' ? { accentColor: 'var(--accent-9, #3e63dd)', width: '16px', height: '16px', verticalAlign: 'middle', marginRight: '8px' } : { ...controlStyle, width: '100%' },
        h2: { fontSize: '18px', fontWeight: 600, margin: '0 0 12px' },
        h3: { fontSize: '14px', fontWeight: 600, margin: '0 0 12px' },
        p: { margin: '8px 0', lineHeight: 1.6, color: secondary },
        legend: { fontSize: '14px', fontWeight: 600, padding: '0 6px' },
        a: { color: accent, display: 'inline-block', margin: '8px 0' },
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
function parseAccount(value) {
    if (!isRecord(value) || !['ok', 'unavailable', 'auth-required', 'error'].includes(String(value.status)))
        throw new Error('服务端状态格式无效');
    const result = { status: value.status };
    for (const key of ['remaining', 'total', 'used']) {
        if (typeof value[key] === 'number' && Number.isFinite(value[key]))
            result[key] = value[key];
    }
    for (const key of ['unit', 'updatedAt']) {
        if (typeof value[key] === 'string')
            result[key] = value[key].slice(0, 128);
    }
    return result;
}
function parsePool(value) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value) || !['fixed', 'pool'].includes(String(value.mode)) || !Array.isArray(value.accounts)
        || (value.selectedAccountId !== undefined && typeof value.selectedAccountId !== 'string'))
        throw new Error('服务端状态格式无效');
    const accounts = value.accounts.map(entry => {
        if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string'
            || typeof entry.enabled !== 'boolean' || !['ready', 'auth-required'].includes(String(entry.authState))
            || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt)))
            throw new Error('服务端状态格式无效');
        const account = { id: entry.id, name: entry.name.slice(0, 128), enabled: entry.enabled,
            authState: entry.authState, createdAt: entry.createdAt };
        if (bounded(entry.active, 0, Number.MAX_SAFE_INTEGER))
            account.active = entry.active;
        if (entry.quota !== undefined)
            account.quota = parseAccount(entry.quota);
        if (entry.catalogModels !== undefined) {
            if (!Array.isArray(entry.catalogModels) || !entry.catalogModels.every(model => isRecord(model) && isRequestModelIdentifier(model.id) && typeof model.name === 'string'))
                throw new Error('服务端状态格式无效');
            account.catalogModels = entry.catalogModels.map(model => ({ id: model.id, name: model.name.slice(0, 128) }));
        }
        return account;
    });
    return { mode: value.mode, selectedAccountId: value.selectedAccountId, accounts };
}
// Discovery messages are plugin-authored diagnostics, not arbitrary upstream text.
// This classic entry cannot import the server module; fail closed on unknown prose.
function parseModelMessage(value) {
    if (typeof value !== 'string' || value.length > 1000)
        return '';
    const allowed = new Set([
        '已获取中国区官方 CLI 目录。', '已获取国际区公开 CLI 目录。', '已合并安装包 CLI 模型候选。',
        '国际区公开目录未能获取，可能需要国际区独立授权；当前候选不代表完整国际目录，未向国际域名发送中国区凭据。',
        '模型候选未验证账户可用权限；实际调用仍受地区、账户权限与余额限制。',
        ...['官方配置未返回可识别的 CLI 模型列表。', '拒绝模型配置重定向。', '官方模型配置需要有效授权。',
            '官方模型配置请求失败。', '官方模型配置响应格式未知。', '模型发现超时。',
            '模型发现失败；请检查网络或显式授权。'].map(message => `中国区：${message}`),
    ]);
    // Sentences may contain spaces in "CLI 目录"; consume complete known messages.
    let rest = value;
    while (rest) {
        const part = [...allowed].find(message => rest === message || rest.startsWith(message + ' '));
        if (!part)
            return '';
        rest = rest.slice(part.length).trimStart();
    }
    return value;
}
function parseStatus(value) {
    if (!isRecord(value) || !isRecord(value.config) || !isRecord(value.account))
        throw new Error('服务端状态格式无效');
    const c = value.config;
    if ((value.settingsError !== undefined && typeof value.settingsError !== 'string')
        || typeof c.enabled !== 'boolean' || typeof c.permissionMode !== 'string'
        || !strings(c.models) || !c.models.every(isRequestModelIdentifier)
        || !strings(c.hiddenModels) || !c.hiddenModels.every(isRequestModelIdentifier)
        || !isRequestModelIdentifier(c.defaultModel) || typeof c.tools !== 'string' || !Array.isArray(value.catalogModels)
        || !value.catalogModels.every(model => isRecord(model) && isRequestModelIdentifier(model.id) && typeof model.name === 'string')
        || !['ok', 'unavailable', 'auth-required', 'error'].includes(String(value.account.status)))
        throw new Error('服务端状态格式无效');
    // Missing fields from older servers keep the safe defaults; reject malformed new values.
    const dangerouslySkipPermissions = c.dangerouslySkipPermissions === undefined ? false : c.dangerouslySkipPermissions;
    if (typeof dangerouslySkipPermissions !== 'boolean')
        throw new Error('服务端状态格式无效');
    const reasoningEffort = c.reasoningEffort ?? 'auto';
    const maxConcurrency = c.maxConcurrency ?? 2;
    const queueTimeoutMs = c.queueTimeoutMs ?? 600000;
    const stallWarnMs = c.stallWarnMs ?? 90000;
    if (typeof reasoningEffort !== 'string' || !efforts.includes(reasoningEffort) || !bounded(maxConcurrency, 1, 16)
        || !bounded(queueTimeoutMs, 1, 2147483647) || !bounded(stallWarnMs, 0, 2147483647))
        throw new Error('服务端状态格式无效');
    return { settingsError: typeof value.settingsError === 'string' && value.settingsError.length > 0,
        modelMessage: parseModelMessage(value.modelMessage),
        config: { enabled: c.enabled, permissionMode: c.permissionMode, models: c.models, hiddenModels: c.hiddenModels,
            defaultModel: c.defaultModel, tools: c.tools, dangerouslySkipPermissions, reasoningEffort, maxConcurrency, queueTimeoutMs, stallWarnMs },
        account: parseAccount(value.account), accountPool: parsePool(value.accountPool),
        catalogModels: value.catalogModels.map(model => ({ id: model.id, name: model.name })),
        auth: { configured: isRecord(value.auth) && value.auth.configured === true }, runs: parseRuns(value.runs) };
}
// Mirror src/model-id.ts: the classic browser entry cannot import server modules.
function isRequestModelIdentifier(value) {
    return typeof value === 'string' && value.length <= 256 && !/^[a-zA-Z]:/.test(value)
        && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.exec(value)?.[0] === value;
}
function isReturnedModelIdentifier(value) {
    if (typeof value !== 'string' || value.length > 256)
        return false;
    const parts = value.split('/');
    return (parts.length === 1 || parts.length === 2) && parts.every(isRequestModelIdentifier) && !value.includes(':/');
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
            requestedModel: isRequestModelIdentifier(entry.requestedModel) ? entry.requestedModel : 'unknown', requestedEffort: efforts.includes(entry.requestedEffort) ? entry.requestedEffort : 'auto', queuedAt: entry.queuedAt,
            contextOverrideSent: false, reasoningConfirmed: false, warning: entry.warning === true,
            queuePosition: bounded(entry.queuePosition, 0, Number.MAX_SAFE_INTEGER) ? entry.queuePosition : 0 };
        if (typeof entry.accountId === 'string')
            run.accountId = entry.accountId;
        if (typeof entry.accountName === 'string')
            run.accountName = entry.accountName.slice(0, 128);
        if (isReturnedModelIdentifier(entry.returnedModel))
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
    if (action === 'poll' && (value.status === 'pending' || value.status === 'ok'))
        return { status: value.status };
    if (action === 'cancel' && value.status === 'cancelled')
        return { status: value.status };
    throw new Error('登录响应格式无效');
}
async function request(action, body) {
    let response;
    try {
        response = await fetch(`/plugins/codebuddy-link/${action}`, {
            method: body === undefined ? 'GET' : 'POST',
            credentials: 'same-origin',
            mode: 'same-origin',
            signal: AbortSignal.timeout(20_000),
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        });
    }
    catch {
        throw new Error('请求失败，请重试');
    }
    // Only /status's exact, plugin-authored repair diagnostic may cross this boundary.
    // Account/auth mutations and unknown response text remain generic, never raw errors.
    if (!response.ok) {
        let diagnostic = '';
        if (action === 'status') {
            try {
                const value = await response.json();
                if (isRecord(value) && value.error === 'Cannot read CodeBuddy accounts; repair the account store before continuing') {
                    diagnostic = 'CodeBuddy 账户存储无法读取，请修复账户存储后重试；不会回退本机登录。';
                }
            }
            catch { /* Non-JSON errors retain the generic HTTP diagnostic. */ }
        }
        throw new Error(diagnostic || `请求失败（HTTP ${response.status}）`);
    }
    let value;
    try {
        value = await response.json();
    }
    catch {
        throw new Error('服务端状态格式无效');
    }
    return parseStatus(value);
}
const box = { padding: '14px', border, borderRadius: '8px', marginBottom: '14px' };
const row = { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' };
const field = { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 };
const text = (value) => typeof value === 'string' && value.trim() ? value : '未知';
const amount = (value) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '未知';
const settingsErrorHelp = 'CodeBuddy 配置无法加载，模型调用已停用。请修复插件 settings.json 或管理员配置后重启 DSH；原文件未修改。';
const safetyHelp = 'ACP 原生工具绕过 DSH 文件沙箱与确认流程，可直接读写文件、执行命令，也可能继承含凭据的环境变量或读取当前用户的文件。仅在信任当前工作区时使用。权限模式也用于独立委派；启用的独立委派工具同样不受 DSH 文件沙箱约束。';
const dangerHelp = '默认关闭。启用后为主调用传入 --dangerously-skip-permissions。若 CLI 仍请求权限，插件会选择其提供的单次允许选项；不会选择永久授权。不会隐式应用到独立委派或标题、压缩等后台请求；CLI 不受 DSH 沙箱与确认流程保护。';
function renderRun(run) {
    const labels = { queued: '排队中', starting: '启动中', waiting: '等待响应', responding: '响应中', completed: '已完成', failed: '失败', cancelled: '已取消' };
    const failures = { 'timeout': '执行超时', 'queue-timeout': '排队超时', 'aborted': '已中止', 'error': '执行失败' };
    const time = (value) => value === undefined ? '未知' : new Date(value).toLocaleTimeString();
    return h('article', { key: run.id, style: { borderTop: border, padding: '8px 0', overflowWrap: 'anywhere' } }, h('div', { style: row }, h('strong', null, labels[run.state]), h('span', null, run.source === 'model' ? '模型调用' : '独立委派'), h('span', { style: { color: secondary } }, run.requestedModel), run.accountName ? h('span', null, run.accountName) : null, run.state === 'queued' ? h('span', null, `队列位置：${run.queuePosition}`) : null), h('p', null, `请求模型：${text(run.requestedModel)}；返回模型：${text(run.returnedModel)}`), h('p', null, `请求推理强度：${text(run.requestedEffort)}（服务端未确认）`), h('p', null, `DSH 上下文预算：${run.contextWindow ?? '未知'}；来源：${run.contextSource === 'model' ? '模型元数据' : run.contextSource === 'fallback' ? '回退配置' : '未知'}；未向 CLI 覆盖上下文限制`), h('p', null, `积分：${amount(run.totalCredits)}；费用（USD）：${amount(run.totalCostUsd)}`), h('p', null, `入队：${time(run.queuedAt)}；开始：${time(run.startedAt)}；进展：${time(run.lastProgressAt)}；结束：${time(run.endedAt)}`), run.warning ? h('p', { role: 'status' }, '长时间无进展，仍在等待；这不代表调用失败。') : null, run.failure ? h('p', null, failures[run.failure]) : null);
}
function SettingsPanel() {
    const [status, storeStatus] = useState(null);
    const [draft, setDraft] = useState(null);
    const [busy, setBusy] = useState('加载中');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const active = useRef(false);
    const sequence = useRef(0);
    const pending = useRef(false);
    const [authFlow, setAuthFlow] = useState(null);
    const [authBusy, setAuthBusy] = useState(false);
    const [authError, setAuthError] = useState('');
    const [authNotice, setAuthNotice] = useState('');
    const authPending = useRef(false);
    const authSequence = useRef(0);
    const [renaming, setRenaming] = useState(null);
    const [accountName, setAccountName] = useState('');
    const [removing, setRemoving] = useState(null);
    const [hoverHelp, setHoverHelp] = useState(null);
    const [focusHelp, setFocusHelp] = useState(null);
    const [dismissedHelp, setDismissedHelp] = useState(null);
    const tooltipPrefix = useRef(`codebuddy-help-${Math.random().toString(36).slice(2)}`);
    const polling = useRef(null);
    const settingsError = useRef(false);
    // Update the guard synchronously so even handlers captured before recovery mode
    // cannot save, including before React commits the next render.
    function setStatus(result) {
        settingsError.current = result.settingsError;
        storeStatus(result);
    }
    // Polls are read-only and leave controls enabled. An explicit operation reserves
    // its lock immediately, invalidates the poll, then waits for it to settle.
    function pollStatus() {
        if (!active.current || polling.current || pending.current || authPending.current)
            return;
        const ticket = ++sequence.current;
        const work = request('status').then(result => {
            if (!active.current || ticket !== sequence.current)
                return;
            setStatus(result);
            setDraft(previous => previous ?? result.config);
        }).catch(() => {
            // Background failures must not hide explicit errors or prevent queued work.
        }).finally(() => { if (polling.current === work)
            polling.current = null; });
        polling.current = work;
    }
    // Hold the in-flight lock across the full chain and check generation after every await.
    async function refreshAccount(current) {
        const account = await request('refresh', {});
        if (!current())
            return;
        setStatus(account);
        const canDiscover = account.accountPool ? account.accountPool.accounts.some(item => item.enabled && item.authState === 'ready') : account.account.status === 'ok';
        if (!canDiscover)
            return;
        const models = await request('models', {});
        if (current())
            setStatus(models);
    }
    async function authenticate(action, accountId) {
        if (!active.current || authPending.current || pending.current || !status)
            return;
        if (action === 'start' && authFlow)
            return;
        if ((action === 'poll' || action === 'cancel') && !authFlow)
            return;
        authPending.current = true;
        const ticket = ++authSequence.current;
        ++sequence.current;
        setAuthBusy(true);
        setAuthError('');
        setAuthNotice('');
        const current = () => active.current && ticket === authSequence.current;
        try {
            if (polling.current)
                await polling.current;
            if (!current())
                return;
            const result = await requestAuth(action, action === 'poll' || action === 'cancel' ? { flowId: authFlow.flowId }
                : accountId ? { accountId } : {});
            if (!current())
                return;
            if (action === 'start') {
                setAuthFlow(result);
                setAuthNotice('在官方页面授权后，检查登录结果。');
            }
            else if (action === 'cancel') {
                setAuthFlow(null);
                setAuthNotice('登录已取消，已有账户保持不变。');
            }
            else if (result.status === 'pending') {
                setAuthNotice('尚未完成登录，请授权后再次检查。');
            }
            else {
                setAuthFlow(null);
                setAuthNotice('登录信息已更新。');
                // Auth never replaces the user's unsaved model draft.
                try {
                    await refreshAccount(current);
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
    async function load(action, config) {
        if (!active.current || pending.current || authPending.current || (action === 'config' && settingsError.current))
            return;
        pending.current = true;
        const ticket = ++sequence.current;
        setBusy(action === 'config' ? '保存中' : action === 'refresh' ? '刷新中' : '加载中');
        setError('');
        setNotice('');
        const current = () => active.current && ticket === sequence.current;
        try {
            if (polling.current)
                await polling.current;
            if (!current() || (action === 'config' && settingsError.current))
                return;
            if (action !== 'refresh') {
                const endpoint = action === 'initial' ? 'status' : action;
                const result = await request(endpoint, endpoint === 'status' ? undefined : endpoint === 'models' ? {} : {
                    permissionMode: config.permissionMode, dangerouslySkipPermissions: config.dangerouslySkipPermissions,
                    models: config.models, hiddenModels: config.hiddenModels, defaultModel: config.defaultModel, reasoningEffort: config.reasoningEffort,
                });
                if (!current())
                    return;
                setStatus(result);
                if (action === 'config')
                    setDraft(result.config);
                else
                    setDraft(previous => previous ?? result.config);
            }
            if (action === 'initial' || action === 'refresh')
                await refreshAccount(current);
            if (!current())
                return;
            setNotice(action === 'config' ? '设置已保存' : action === 'refresh' ? '账户状态已刷新' : '');
        }
        catch (cause) {
            if (current())
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
    async function manageAccount(action, body) {
        if (!active.current || pending.current || authPending.current || authFlow)
            return;
        pending.current = true;
        const ticket = ++sequence.current;
        setBusy('更新中');
        setError('');
        setNotice('');
        try {
            if (polling.current)
                await polling.current;
            if (!active.current || ticket !== sequence.current)
                return;
            const result = await request(action, body);
            if (!active.current || ticket !== sequence.current)
                return;
            setStatus(result);
            setRenaming(null);
            setRemoving(null);
            setNotice('账户已更新');
        }
        catch (cause) {
            if (active.current && ticket === sequence.current)
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
        setAuthBusy(false);
        void load('initial');
        const timer = setInterval(pollStatus, 2000);
        return () => { clearInterval(timer); active.current = false; ++sequence.current; ++authSequence.current; pending.current = false; authPending.current = false; polling.current = null; };
    }, []);
    function help(key, label, description, trigger = '?') {
        const id = `${tooltipPrefix.current}-${key}`;
        const visible = dismissedHelp !== key && (hoverHelp === key || focusHelp === key);
        return h('span', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
            onMouseEnter: () => { setHoverHelp(key); setDismissedHelp(null); }, onMouseLeave: () => setHoverHelp(null) }, h('button', { type: 'button', 'aria-label': label, 'aria-describedby': visible ? id : undefined,
            onFocus: () => { setFocusHelp(key); setDismissedHelp(null); }, onBlur: () => setFocusHelp(null),
            onKeyDown: (event) => { if (event.key === 'Escape')
                setDismissedHelp(key); },
            onClick: () => { setFocusHelp(key); setDismissedHelp(null); },
            style: { minHeight: '24px', minWidth: '24px', padding: '1px 6px', fontSize: '12px', color: key === 'danger' ? 'var(--red-11, #ce2c31)' : secondary } }, trigger), visible ? h('span', { id, role: 'tooltip', style: { position: 'absolute', zIndex: 10, top: '100%', left: key === 'safety' ? '-180px' : '-160px', width: 'min(320px, 70vw)',
                boxSizing: 'border-box', padding: '10px 12px', border, borderRadius: '6px', background: 'var(--dsw-alias-bg-base, var(--gray-2, #202124))',
                color: foreground, boxShadow: '0 4px 16px rgba(0,0,0,0.15)', fontSize: '12px', fontWeight: 400, lineHeight: 1.6 } }, description) : null);
    }
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
    const validEffort = !!draft && efforts.includes(draft.reasoningEffort);
    const pool = status?.accountPool;
    const locked = !!busy || authBusy;
    const accountLocked = locked || !!authFlow;
    const selectedStyle = { borderColor: accent, color: accent, background: 'var(--accent-3, var(--dsw-alias-bg-layer-1, transparent))' };
    const accountLabels = { ok: '可用', unavailable: '暂不可用', 'auth-required': '需要登录', error: '查询失败' };
    function quotaView(account) {
        const percent = typeof account?.remaining === 'number' && typeof account.total === 'number' && account.total > 0
            ? Math.max(0, Math.min(100, account.remaining / account.total * 100)) : undefined;
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, h('div', { style: { ...row, gap: '10px', color: secondary, fontSize: '12px' } }, h('span', null, `剩余：${amount(account?.remaining)}`), h('span', null, `总额：${amount(account?.total)}`), h('span', null, `已用：${amount(account?.used)}`), account?.status && account.status !== 'ok' ? h('span', null, accountLabels[account.status]) : null), percent === undefined ? null : h('div', { role: 'meter', 'aria-label': '剩余积分比例', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100,
            style: { height: '4px', borderRadius: '2px', background: 'var(--gray-4, #e8e8ec)', overflow: 'hidden' } }, h('div', { style: { width: `${percent}%`, height: '100%', background: accent } })));
    }
    return h('section', { 'aria-label': 'CodeBuddy 设置', style: { maxWidth: '800px', width: '100%', boxSizing: 'border-box', padding: '16px', fontSize: '13px', lineHeight: 1.5, color: foreground } }, h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: '12px' } }, h('h2', { style: { margin: 0, fontSize: '16px' } }, 'CodeBuddy'), status ? h('span', { style: { fontSize: '12px', color: secondary } }, status.config.enabled ? '已启用' : '未启用') : null), h('div', { role: 'status', 'aria-live': 'polite', style: { color: secondary, marginBottom: busy || notice ? '8px' : 0 } }, busy ? `${busy}…` : notice), status?.settingsError ? h('div', { role: 'alert', style: { marginBottom: '10px' } }, settingsErrorHelp) : null, error ? h('div', { role: 'alert', style: { marginBottom: '10px' } }, error, !status ? h('button', { type: 'button', disabled: !!busy, onClick: () => void load('initial') }, '重试加载') : null) : null, h('section', { style: box, 'aria-label': '账户列表' }, h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: '10px' } }, h('h3', { style: { margin: 0 } }, '账户'), h('div', { style: row }, h('button', { type: 'button', disabled: accountLocked || !status, onClick: () => void load('refresh') }, '刷新账户'), h('button', { type: 'button', disabled: accountLocked || !status, onClick: () => void authenticate('start') }, '添加账户'))), h('div', { role: 'group', 'aria-label': '账户使用方式', style: { ...row, marginBottom: '10px' } }, h('button', { type: 'button', 'aria-pressed': pool?.mode === 'fixed', disabled: accountLocked || !pool?.accounts.some(account => account.enabled && account.authState === 'ready'),
        style: pool?.mode === 'fixed' ? selectedStyle : {}, onClick: () => void manageAccount('account/select', { mode: 'fixed', accountId: pool?.selectedAccountId ?? pool?.accounts.find(account => account.enabled && account.authState === 'ready')?.id }) }, '固定账户'), h('button', { type: 'button', 'aria-pressed': pool?.mode === 'pool', disabled: accountLocked || !pool,
        style: pool?.mode === 'pool' ? selectedStyle : {}, onClick: () => void manageAccount('account/select', { mode: 'pool' }) }, '账户池')), ...(pool?.accounts ?? []).map(account => h('div', { key: account.id, 'aria-label': `账户 ${account.name}`, style: { borderTop: border, padding: '10px 0', display: 'flex', flexDirection: 'column', gap: '6px' } }, h('div', { style: { ...row, justifyContent: 'space-between' } }, h('div', { style: { ...row, minWidth: 0 } }, h('strong', { style: { overflowWrap: 'anywhere' } }, account.name), h('span', { style: { fontSize: '12px', color: secondary } }, !account.enabled ? '已停用' : account.authState === 'ready' ? '已授权' : '需授权'), pool.mode === 'fixed' && pool.selectedAccountId === account.id ? h('span', { style: { fontSize: '12px', color: accent } }, '当前') : null, account.active ? h('span', { style: { fontSize: '12px', color: secondary } }, `运行中 ${account.active}`) : null), h('div', { style: row }, h('button', { type: 'button', disabled: accountLocked || !account.enabled || account.authState !== 'ready' || (pool.mode === 'fixed' && pool.selectedAccountId === account.id), onClick: () => void manageAccount('account/select', { mode: 'fixed', accountId: account.id }) }, '使用'), h('button', { type: 'button', disabled: accountLocked, onClick: () => { setRenaming(account.id); setAccountName(account.name); setRemoving(null); } }, '重命名'), h('button', { type: 'button', disabled: accountLocked, 'aria-label': `${account.enabled ? '停用' : '启用'} ${account.name}`, onClick: () => void manageAccount('account/update', { id: account.id, enabled: !account.enabled }) }, account.enabled ? '停用' : '启用'), h('button', { type: 'button', disabled: accountLocked, onClick: () => void authenticate('start', account.id) }, '重新授权'), h('button', { type: 'button', disabled: accountLocked, onClick: () => void manageAccount('account/refresh', { id: account.id }) }, '刷新'), h('button', { type: 'button', disabled: accountLocked, onClick: () => { setRemoving(account.id); setRenaming(null); } }, '删除'))), quotaView(account.quota), renaming === account.id ? h('div', { style: row }, h('label', { style: { ...field, flex: '1 1 160px' } }, '账户名称', h('input', { value: accountName, maxLength: 100, disabled: accountLocked, autoComplete: 'off',
        onChange: (event) => setAccountName(event.target.value) })), h('button', { type: 'button', disabled: accountLocked || !accountName.trim(), onClick: () => void manageAccount('account/update', { id: account.id, name: accountName.trim() }) }, '确认重命名'), h('button', { type: 'button', disabled: accountLocked, onClick: () => setRenaming(null) }, '取消重命名')) : null, removing === account.id ? h('div', { role: 'group', 'aria-label': '确认删除账户', style: row }, h('span', null, '删除此账户？'), h('button', { type: 'button', disabled: accountLocked, onClick: () => void manageAccount('account/remove', { id: account.id }) }, '确认删除'), h('button', { type: 'button', disabled: accountLocked, onClick: () => setRemoving(null) }, '保留账户')) : null)), !pool?.accounts.length ? h('div', { style: { color: secondary } }, pool ? '暂无账户，添加账户以在浏览器登录。' : quotaView(status?.account)) : null, h('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: '12px', color: secondary } }, authBusy ? '登录操作中…' : authNotice), authError ? h('p', { role: 'alert' }, authError) : null, authFlow ? h('div', { style: { marginTop: '8px' } }, authFlow.verificationUri ? h('a', { href: authFlow.verificationUri, target: '_blank', rel: 'noopener noreferrer', style: { margin: '0 0 8px' } }, '打开浏览器登录')
        : h('p', { role: 'alert' }, '授权链接不安全，已禁止打开。请取消后重试。'), h('div', { style: row }, h('button', { type: 'button', disabled: locked, onClick: () => void authenticate('poll') }, '检查登录结果'), h('button', { type: 'button', disabled: locked, onClick: () => void authenticate('cancel') }, '取消登录'))) : null), draft ? h('fieldset', { disabled: locked, style: { ...box, minWidth: 0 } }, h('legend', null, h('span', { style: row }, '模型与独立委派设置', help('safety', '模型与独立委派安全说明', safetyHelp))), h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: '10px' } }, h('h3', { style: { margin: 0 } }, '启用模型'), h('button', { type: 'button', disabled: locked, onClick: () => void load('models') }, '获取模型列表')), status?.modelMessage ? h('p', { role: 'status', 'aria-label': '模型发现说明' }, status.modelMessage) : null, h('div', { role: 'group', 'aria-label': '启用模型', style: { ...row, gap: '6px', marginBottom: '14px' } }, ...[...models].map(([id, label]) => {
        const enabled = enabledModels.includes(id);
        return h('button', { key: id, type: 'button', 'aria-pressed': enabled, 'aria-label': `${label} (${id})`,
            style: { borderRadius: '16px', overflowWrap: 'anywhere', ...(enabled ? selectedStyle : {}) },
            onClick: () => update({ models: !enabled ? [...new Set([...draft.models, id])] : draft.models,
                hiddenModels: !enabled ? draft.hiddenModels.filter(hidden => hidden !== id) : [...new Set([...draft.hiddenModels, id])],
                defaultModel: enabled && draft.defaultModel === id ? enabledModels.find(model => model !== id) ?? '' : draft.defaultModel }) }, label);
    })), h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '12px' } }, h('label', { style: field }, '默认模型', h('select', { value: draft.defaultModel, onChange: (event) => update({ defaultModel: event.target.value }) }, h('option', { value: '', disabled: true }, '请选择默认模型'), !validDefault && draft.defaultModel ? h('option', { value: draft.defaultModel, disabled: true }, `${draft.defaultModel}（已禁用，请重选）`) : null, ...enabledModels.map(id => h('option', { key: id, value: id }, models.get(id))))), h('label', { style: field }, '权限模式', h('select', { value: draft.permissionMode, onChange: (event) => update({ permissionMode: event.target.value }) }, !validMode ? h('option', { value: draft.permissionMode, disabled: true }, `未知模式：${draft.permissionMode}`) : null, h('option', { value: 'dontAsk' }, '不询问'), h('option', { value: 'plan' }, '规划模式'), h('option', { value: 'acceptEdits' }, '接受编辑'))), h('label', { style: field }, '默认推理强度', h('select', { value: draft.reasoningEffort, onChange: (event) => update({ reasoningEffort: event.target.value }) }, ...efforts.map(effort => h('option', { key: effort, value: effort }, effort))))), h('div', { style: { ...row, justifyContent: 'space-between' } }, h('div', { style: row }, h('label', { style: { ...row, gap: '4px' } }, h('input', { type: 'checkbox', name: 'dangerouslySkipPermissions', checked: draft.dangerouslySkipPermissions,
        onChange: (event) => update({ dangerouslySkipPermissions: event.target.checked }) }), '跳过 CLI 权限检查'), help('danger', '跳过 CLI 权限检查风险说明', dangerHelp, '危险')), h('button', { type: 'button', disabled: locked || !!status?.settingsError || !validDefault || !validMode || !validEffort, onClick: () => void load('config', draft) }, '保存设置')), !validDefault || !validMode || !validEffort ? h('p', { role: 'alert' }, '请选择有效的权限模式、推理强度与已启用的默认模型。') : null) : null, h('details', { style: box, 'aria-label': '运行记录' }, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, `运行记录（${status?.runs.length ?? 0}）`), h('p', { style: { fontSize: '12px' } }, '当前进程内存最近 5 条，每 2 秒刷新；不保存提示词或原始输出。'), h('div', { style: { maxHeight: '360px', overflowY: 'auto' } }, ...(status?.runs.length ? status.runs.map(renderRun) : [h('p', null, '暂无运行记录')]))));
}
function apply(ctx) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'codebuddy-link', order: 20, label: 'CodeBuddy' }, SettingsPanel));
    const pluginPanel = (props) => isRecord(props) && props.view === 'summary' ? null : h(SettingsPanel);
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-codebuddy-link' }, pluginPanel));
    ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-codebuddy-link#codebuddy-link' }, pluginPanel));
}

return module.exports;
} });
