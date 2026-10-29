import { isModelIdentifier } from "./metadata.js";
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const count = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** CodeBuddy 2.177.1 ACP extensions. Context used/size are NOT billable usage. */
export class AcpUsage {
    messages = new Map();
    credits = new Map();
    accept(value) {
        const row = record(value), meta = record(row._meta), events = [];
        const model = meta['codebuddy.ai/responseModelId'];
        if (isModelIdentifier(model))
            events.push({ type: 'metadata', model });
        if (row.sessionUpdate !== 'usage_update')
            return events;
        const id = meta['codebuddy.ai/messageId'], usage = record(meta.usage);
        // Require explicit complete counts from the verified extension. No guessed zeros.
        const cacheRead = usage.prompt_cache_hit_tokens ?? record(usage.prompt_tokens_details).cached_tokens ?? usage.cache_read_input_tokens;
        const cacheWrite = usage.prompt_cache_write_tokens ?? usage.cache_creation_input_tokens;
        if (typeof id === 'string' && id && count(usage.prompt_tokens) && count(usage.completion_tokens) && count(cacheRead) && count(cacheWrite)) {
            if (!this.messages.has(id) && this.messages.size >= 10000)
                throw new Error('CodeBuddy ACP usage record limit exceeded');
            this.messages.set(id, { input: usage.prompt_tokens, output: usage.completion_tokens, cacheRead, cacheWrite });
            const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
            for (const entry of this.messages.values())
                for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'])
                    total[key] += entry[key];
            if (Object.values(total).every(count))
                events.push({ type: 'usage', ...total });
        }
        const credits = record(meta['codebuddy.ai/requestCredits']);
        for (const [id, amount] of Object.entries(credits)) {
            if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)
                continue;
            if (!this.credits.has(id) && this.credits.size >= 10000)
                throw new Error('CodeBuddy ACP credit record limit exceeded');
            this.credits.set(id, amount);
        }
        if (Object.keys(credits).length && this.credits.size) {
            const totalCredits = [...this.credits.values()].reduce((a, b) => a + b, 0);
            if (Number.isFinite(totalCredits))
                events.push({ type: 'metadata', totalCredits });
        }
        return events;
    }
}
//# sourceMappingURL=acp-usage.js.map