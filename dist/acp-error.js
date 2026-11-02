const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const MAX_ERROR_CHARS = 16 * 1024;
/** Only fixed copy and a validated reset timestamp leave the error boundary. */
export class CodeBuddyLimitError extends Error {
    code;
    status;
    constructor(quota, status, reset) {
        const reason = quota ? '当前模型的使用配额已用尽' : '当前模型请求受到限流';
        const retry = !reset ? '稍后重试' : quota ? `等待配额于 ${reset} 重置后重试` : `等待至 ${reset} 后重试`;
        super(`CodeBuddy ${reason}${status === 429 ? '（429）' : ''}。请切换其他模型继续，或${retry}。`);
        this.name = 'CodeBuddyLimitError';
        // Do not opt native execution into the host's automatic RATE_LIMIT retries:
        // an ACP task may already have changed files or performed external actions.
        this.code = quota ? 'QUOTA' : 'CODEBUDDY_RATE_LIMIT';
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
    const quota = data.category === 'quota' || /\b(?:quota(?:_token_limit|_exceeded)?|insufficient_quota)\b|配额|额度|使用量已超出/i.test(detail);
    const status = data.statusCode === 429 || row.code === 429 || /\b429\b/.test(detail) ? 429 : undefined;
    if (!quota && status !== 429 && data.category !== 'rate_limit')
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
    return new CodeBuddyLimitError(quota, status, reset);
}
//# sourceMappingURL=acp-error.js.map