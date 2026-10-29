import '@deepseek-ai/dsh-commands';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { CodeBuddyAdapter } from "./adapter.js";
import { CODEBUDDY_EFFORTS, resolveConfig } from "./config.js";
import { resolveEffort } from "./effort.js";
import { CallRuntime } from "./runtime.js";
import { SettingsStore } from "./settings.js";
import { registerSettingsRoutes } from "./web.js";
import { AccountStore, AccountAuthManager } from "./accounts.js";
import { AccountService } from "./account-service.js";
export const name = 'dsh-codebuddy-link';
export const inject = ['llm', 'commands'];
export function apply(ctx, entry = {}) {
    const store = new SettingsStore(entry);
    const config = store.config;
    const credentials = new AccountStore();
    const accounts = new AccountService(credentials, config);
    const runtime = new CallRuntime(config, accounts);
    ctx.inject(['webServer'], sub => {
        const server = sub.get('webServer');
        if (!server)
            return;
        const manager = new AccountAuthManager(credentials);
        return registerSettingsRoutes(server, store, () => { runtime.refresh(); accounts.scheduler.refresh(); ctx.emit('llm/adapters-updated'); }, () => accounts.refresh(), {
            status: async () => ({ configured: credentials.list().length > 0 }),
            start: id => manager.start(id), poll: id => manager.poll(id), cancel: id => manager.cancel(id), cancelAll: () => manager.cancelAll(),
        }, () => accounts.discover(), () => runtime.snapshots(), accounts);
    });
    const sessionCwd = (id) => {
        const sessions = ctx.get('sessions');
        return sessions?.get(id)?.header?.cwd;
    };
    if (config.enabled)
        ctx.llm.registerAdapter(['codebuddy'], new CodeBuddyAdapter(config, undefined, sessionCwd, undefined, runtime));
    ctx.commands.register({
        name: 'codebuddy', description: 'CodeBuddy bridge status, models and setup',
        input: { hint: '<status|models|runs|help>' },
        handler: ({ rawInput }) => {
            const command = rawInput.trim() || 'help';
            if (command === 'runs')
                return { kind: 'success', text: JSON.stringify(runtime.snapshots(), null, 2) };
            if (command === 'status')
                return { kind: 'success', text: [
                        '**CodeBuddy bridge**', ...(store.loadError ? [store.loadError] : []), `Enabled: ${config.enabled}`, `CLI: ${config.codebuddyBin || 'codebuddy (PATH)'}`,
                        `Model: ${config.defaultModel}`, `Default effort: ${config.reasoningEffort} (server reasoning unconfirmed)`,
                        `Concurrency: ${config.maxConcurrency}; queue timeout: ${config.queueTimeoutMs}ms; no-progress warning: ${config.stallWarnMs}ms`,
                        'Execution mode: autonomous (ACP stdio, fixed)',
                        `Provider transport: ACP stdio; CodeBuddy native default tools; outside DSH sandbox; skip permissions: ${config.dangerouslySkipPermissions}`,
                        `Delegation tools: ${config.tools || 'disabled'} (${config.permissionMode})`,
                        `Workspace: ${config.workspaceRoot || 'DSH session workspace'}`,
                        'Authentication: fixed account or session-affine account pool; account credentials are injected per child. CLI-local login is used only before any plugin account has been managed.',
                    ].join('\n') };
            if (command === 'models')
                return { kind: 'success', text: config.models.filter(id => !config.hiddenModels.includes(id)).map(id => `- codebuddy/${id}`).join('\n') };
            if (command !== 'help')
                return { kind: 'error', text: `Unknown subcommand: ${command}. Use /codebuddy help.` };
            return { kind: 'success', text: '/codebuddy status — configuration\n/codebuddy models — configured models\n/codebuddy runs — recent sanitized calls in this process\nSelect codebuddy/default in the DSH model picker. Install and sign in to the official CodeBuddy CLI first. Additional model IDs can be configured with DSH_CODEBUDDY_MODELS.' };
        },
    });
    if (!config.enabled || !config.askTool)
        return;
    ctx.inject(['tools'], sub => {
        const tool = defineTool({
            name: 'codebuddy_ask',
            description: 'Ask CodeBuddy CLI a standalone question without changing the current DSH model. No DSH history is sent. Built-in CLI tools are disabled unless the administrator explicitly configured them; enabled CLI tools operate outside the DSH file sandbox.',
            parameters: {
                prompt: { type: 'string', required: true, description: 'Self-contained question or task.' },
                model: { type: 'string', description: 'Exact CodeBuddy model ID, or default.' },
                reasoningEffort: { type: 'string', description: `Override thinking effort (${CODEBUDDY_EFFORTS.join(', ')}). Omit to inherit plugin default; auto uses CLI default.` },
            },
            output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args, exec) {
                const agent = exec.agent;
                const cwd = config.workspaceRoot || agent?.session?.header?.cwd;
                if (config.tools && !cwd)
                    throw new Error('Set workspaceRoot before enabling CodeBuddy delegation tools; session workspace is unavailable');
                if (!args.prompt.trim())
                    throw new Error('prompt must not be empty');
                if (args.prompt.length > config.maxPromptChars)
                    throw new Error('prompt exceeds maxPromptChars');
                let text = '';
                let result = '';
                const model = args.model || config.defaultModel;
                if (!config.models.includes(model) || config.hiddenModels.includes(model))
                    throw new Error('CodeBuddy model is not enabled in settings');
                for await (const event of runtime.run({ prompt: args.prompt, cwd: cwd || process.cwd(), bin: config.codebuddyBin || undefined,
                    effort: resolveEffort(args.reasoningEffort, config.reasoningEffort),
                    model: model === 'default' ? undefined : model, permissionMode: config.permissionMode, tools: config.tools,
                    timeoutMs: config.timeoutMs, signal: exec.signal, sessionId: agent?.session?.header?.id }, 'ask')) {
                    if (event.type === 'text')
                        text += event.delta;
                    if (event.type === 'result')
                        result = event.text;
                }
                return result || text;
            },
        });
        // defineTool copies options; attach the live getter to the resulting definition.
        // Host timers cannot exceed signed 32-bit milliseconds.
        Object.defineProperty(tool, 'timeoutMs', { enumerable: true, get: () => Math.min(2147483647, config.timeoutMs + 2 * config.queueTimeoutMs + 5000) });
        sub.tools.register(tool);
    });
}
export { CodeBuddyAdapter, resolveConfig };
//# sourceMappingURL=index.js.map