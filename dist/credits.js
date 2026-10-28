import { open } from 'node:fs/promises';
const ENDPOINT = 'https://www.codebuddy.cn/v2/billing/meter/get-user-resource';
const SOURCE = 'CodeBuddy 中国区（实验性只读查询）';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function result(status, message) {
    return { status, message, source: SOURCE };
}
const unavailable = (message) => result('unavailable', message);
function amount(value) {
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim()))
        return;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER)
        return number;
}
async function readFileCredentials(path) {
    if (!path)
        return undefined;
    const file = await open(path, 'r');
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 64 * 1024)
            return undefined;
        // Bounded read even if another process grows the file after stat.
        const bytes = Buffer.alloc(64 * 1024 + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 64 * 1024)
            return undefined;
        return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    }
    finally {
        await file.close();
    }
}
function credentials(value) {
    const session = object(value), auth = object(session?.auth), account = object(session?.account);
    if (!auth || !account || (auth.tokenType !== undefined && auth.tokenType !== 'Bearer'))
        return;
    if (account.enterpriseId || session?.domain || session?.baseUrl)
        return;
    const token = auth.accessToken, uid = account.uid;
    // Protected credential objects and header/control-character injection are never forwarded.
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token) || token.length > 16384 || /^(encrypted|protected|enc)[.:_-]/i.test(token))
        return;
    if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(uid))
        return;
    return { token, uid };
}
async function readResponse(response) {
    if (!response.body)
        throw new Error('Missing response body');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done)
                break;
            size += next.value.byteLength;
            if (size > 1024 * 1024)
                throw new Error('Response too large');
            chunks.push(next.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
function localTime(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function quotaAmount(row, keys) {
    for (const key of keys) {
        const value = amount(row[key]);
        if (value !== undefined)
            return value;
    }
}
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    const record = object(value);
    return record ? JSON.stringify(Object.keys(record).sort().map(key => [key, canonical(record[key])])) : JSON.stringify(value);
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
export function createAccountRefresher(options = {}) {
    const fetcher = options.fetch ?? globalThis.fetch;
    const readCredentials = options.readCredentials ?? (() => readFileCredentials(options.credentialsFile ?? process.env.DSH_CODEBUDDY_CREDENTIALS_FILE));
    return async () => {
        let raw;
        try {
            raw = await readCredentials();
        }
        catch {
            return unavailable('无法只读加载显式凭据文件；请检查文件格式和权限。');
        }
        if (raw === undefined || raw === null)
            return unavailable('未配置可读凭据；请设置 DSH_CODEBUDDY_CREDENTIALS_FILE。');
        const login = credentials(raw);
        if (!login)
            return unavailable('凭据格式不受支持（仅支持中国区个人账户明文 Bearer 会话；不解密或刷新登录态）。');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
            const now = (options.now ?? (() => new Date()))();
            let total = 0, remaining = 0, count = 0;
            let format;
            let expectedCount;
            const seenRows = new Set();
            const complete = () => ({ status: 'ok', total, remaining, used: Math.max(0, total - remaining), unit: '积分', source: SOURCE, updatedAt: now.toISOString() });
            const end = new Date(now.getFullYear() + 100, now.getMonth(), now.getDate());
            for (let page = 1; page <= MAX_PAGES; page++) {
                const response = await fetcher(ENDPOINT, {
                    method: 'POST', redirect: 'error', signal: controller.signal,
                    headers: { Authorization: `Bearer ${login.token}`, 'X-User-Id': login.uid, 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9', 'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2' },
                    body: JSON.stringify({ PageNumber: page, PageSize: PAGE_SIZE, ProductCode: 'p_tcaca', Status: [0, 3],
                        PackageEndTimeRangeBegin: localTime(now), PackageEndTimeRangeEnd: localTime(end) }),
                });
                if (response.status === 401 || response.status === 403)
                    return result('auth-required', '认证失败；请在官方客户端重新登录后更新凭据。');
                if (!response.ok || response.redirected || (response.url && response.url !== ENDPOINT))
                    return result('error', '官方积分请求失败；未跟随重定向。');
                const payload = object(await readResponse(response));
                if (!payload)
                    return unavailable('积分响应格式未知。');
                const code = payload.code === undefined ? undefined : Number(payload.code);
                if (code === 401 || code === 403)
                    return result('auth-required', '认证失败；请在官方客户端重新登录。');
                if (code !== undefined && code !== 0 && code !== 200)
                    return unavailable('官方接口未返回已知成功状态。');
                const data = object(payload.data ?? payload);
                const responseData = object(data?.Response ?? data);
                const accountsData = object(responseData?.Data ?? responseData);
                if (responseData?.Error)
                    return unavailable('官方接口返回错误。');
                const currentFormat = Array.isArray(accountsData?.Accounts) ? 'accounts' : Array.isArray(data?.resources) ? 'resources' : undefined;
                const rows = currentFormat === 'accounts' ? accountsData?.Accounts : data?.resources;
                if (!currentFormat || !Array.isArray(rows) || rows.length > PAGE_SIZE || (format && currentFormat !== format))
                    return unavailable('积分资源格式未知或分页格式变化。');
                format = currentFormat;
                const reportedCount = accountsData?.TotalCount ?? responseData?.TotalCount ?? data?.totalCount;
                if (reportedCount !== undefined) {
                    const parsedCount = amount(reportedCount);
                    if (parsedCount === undefined || !Number.isSafeInteger(parsedCount) || (expectedCount !== undefined && expectedCount !== parsedCount))
                        return unavailable('分页总数无效或变化，无法确认完整积分。');
                    expectedCount = parsedCount;
                }
                if (rows.length === 0) {
                    if (!count)
                        return unavailable('未返回个人积分资源；不能据此推断零余额。');
                    if (expectedCount !== undefined && count !== expectedCount)
                        return unavailable('分页提前结束，无法确认完整积分。');
                    return complete();
                }
                const pageRows = new Set();
                for (const value of rows) {
                    const row = object(value);
                    if (!row || row.Unlimited === true || row.unlimited === true)
                        return unavailable('资源包含未知或无限配额。');
                    // Compare against previous pages only: separate grants can have identical
                    // names and amounts within one response. Never deduplicate by PackageCode.
                    const rowKey = canonical(row);
                    if (seenRows.has(rowKey))
                        return unavailable('分页返回重复资源，无法确认完整积分。');
                    pageRows.add(rowKey);
                    for (const key of ['unit', 'Unit']) {
                        if (row[key] !== undefined && row[key] !== 'credits' && row[key] !== '积分')
                            return unavailable('资源单位不受支持，不能混合统计。');
                    }
                    // Status is already a request filter; the reference intentionally does not
                    // reject other/missing returned Status values (valid grants can use them).
                    const size = format === 'resources' ? amount(row.total) : quotaAmount(row, ['CycleCapacitySizePrecise', 'CycleCapacitySize', 'CapacitySizePrecise', 'CapacitySize']);
                    const left = format === 'resources' ? amount(row.remaining) : quotaAmount(row, ['CycleCapacityRemainPrecise', 'CycleCapacityRemain', 'CapacityRemainPrecise', 'CapacityRemain']);
                    if (size === undefined || left === undefined || left > size)
                        return unavailable('积分字段缺失或无效；未使用估算值。');
                    total += size;
                    remaining += left;
                    count++;
                    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER || remaining > Number.MAX_SAFE_INTEGER)
                        return unavailable('积分数值超出安全范围。');
                }
                for (const key of pageRows)
                    seenRows.add(key);
                if (expectedCount !== undefined) {
                    if (count > expectedCount)
                        return unavailable('资源数量超过分页总数，无法确认完整积分。');
                    if (count === expectedCount)
                        return complete();
                }
                else if (rows.length < PAGE_SIZE)
                    return complete();
            }
            return unavailable('分页超过安全上限，无法确认完整积分。');
        }
        catch {
            return result('error', '积分查询失败或超时；请检查官方登录和网络。');
        }
        finally {
            clearTimeout(timer);
        }
    };
}
//# sourceMappingURL=credits.js.map