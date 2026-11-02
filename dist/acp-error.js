const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const MAX_ERROR_CHARS = 16 * 1024;
/** Only fixed copy and a validated reset timestamp leave the error boundary. */
export class CodeBuddyLimitError extends Error {
    code;
    status;
    constructor(kind, status, reset) {
        const reason = { usage: '当前模型用量已达上限', credits: '账户积分或余额不足', quota: '请求配额不足（上游未说明是模型用量限制还是账户余额不足）', rate: '请求频率受限' }[kind];
        const recovery = reset ? `恢复时间：${reset}。` : '恢复时间：上游未提供。';
        const advice = kind === 'credits' ? '请检查账户积分、余额或套餐。'
            : kind === 'quota' ? '请检查账户用量，或切换其他模型重试。'
                : `请切换其他模型继续，或${reset ? '等待恢复后重试' : '稍后重试'}。`;
        super(`CodeBuddy ${reason}${status !== undefined ? `（HTTP ${status}）` : ''}。${recovery}${advice}`);
        this.name = 'CodeBuddyLimitError';
        // QUOTA makes current DSH replace the useful message with generic copy.
        // Keep provider-specific codes to preserve details, and do not opt native
        // execution into automatic RATE_LIMIT retries that could replay actions.
        this.code = kind === 'rate' ? 'CODEBUDDY_RATE_LIMIT' : kind === 'credits' ? 'CODEBUDDY_CREDITS' : 'CODEBUDDY_QUOTA';
        this.status = status;
    }
}
/** Inspect only ACP error surfaces, never assistant text, tool output or stderr. */
export function acpLimitError(value) {
    let raw = '';
    if (typeof value === 'string') {
        if (value.length > MAX_ERROR_CHARS)
            return;
        raw = value;
        try {
            value = JSON.parse(value);
            raw = '';
        }
        catch { /* Older CLI versions send plain error text. */ }
    }
    const row = object(value);
    const data = object(row.data);
    const strings = [row.message, data.details].filter((item) => typeof item === 'string' && item.length <= MAX_ERROR_CHARS);
    const detail = strings.length ? strings.join('\n') : raw;
    const credits = /(?:积分|余额)(?:已)?(?:不足|耗尽|用尽)|(?:insufficient|exhausted|depleted)[ _-]*(?:credits?|balance)|(?:credits?|balance)[ _-]*(?:insufficient|exhausted|depleted)|credit balance is too low/i.test(detail);
    const usage = /quota_token_limit|使用量已超出|(?:token|usage)[ _-]*(?:quota|limit)[ _-]*(?:exceeded|exhausted|reached)|(?:exceeded|exhausted)[ _-]*(?:token|usage)[ _-]*(?:quota|limit)/i.test(detail);
    const quota = data.category === 'quota' || /\b(?:quota(?:_token_limit|_exceeded)?|insufficient_quota)\b|配额|额度/i.test(detail);
    const explicitStatus = typeof data.statusCode === 'number' ? data.statusCode : row.code;
    // A bare number can be a request ID or remaining balance. Status now gates
    // native continuation, so text must explicitly identify an HTTP response.
    const statusText = /\b(?:HTTP(?:\/\d(?:\.\d)?)?(?:\s+(?:status(?:\s+code)?|error))?|status(?:Code|\s+code)?)\s*[:=]?\s*(429|402)\b/i.exec(detail);
    const textStatus = statusText ? Number(statusText[1]) : /\b429\s+Too\s+Many\s+Requests\b/i.test(detail) ? 429 : /\b402\s+Payment\s+Required\b/i.test(detail) ? 402 : undefined;
    const status = typeof explicitStatus === 'number' && Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
        ? explicitStatus : textStatus;
    if (!credits && !usage && !quota && status !== 429 && data.category !== 'rate_limit')
        return;
    // Extract only an explicitly labelled reset time, including its timezone.
    // Never echo arbitrary upstream text: it may include credentials/private URLs.
    const match = /(?:将在|重置时间[:：]?|resets?(?:\s+at)?[:：]?)\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC[+-](?:(?:0?\d|1[0-3])(?::[0-5]\d)?|14(?::00)?)|Z)(?=\s|重置|[.,，。;；]|$)/i.exec(detail);
    let reset;
    if (match) {
        const [, date, time, zone] = match;
        const offset = zone.toUpperCase() === 'Z' ? 'Z' : zone.replace(/^UTC([+-])(\d{1,2})(?::(\d{2}))?$/i, (_all, sign, hour, minute) => `${sign}${hour.padStart(2, '0')}:${minute ?? '00'}`);
        const stamp = `${date}T${time}Z`;
        if (Number.isFinite(Date.parse(`${date}T${time}${offset}`)) && new Date(stamp).toISOString() === `${date}T${time}.000Z`)
            reset = `${date} ${time} ${zone.toUpperCase()}`;
    }
    return new CodeBuddyLimitError(credits ? 'credits' : usage ? 'usage' : quota ? 'quota' : 'rate', status, reset);
}
//# sourceMappingURL=acp-error.js.map