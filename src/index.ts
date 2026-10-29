import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CodeBuddyAdapter } from './adapter.ts'
import { CODEBUDDY_EFFORTS, resolveConfig } from './config.ts'
import { resolveEffort } from './effort.ts'
import { CallRuntime } from './runtime.ts'
import { runCodeBuddy } from './runner.ts'
import { SettingsStore } from './settings.ts'
import { registerSettingsRoutes, type WebServerLike } from './web.ts'
import { createAccountRefresher } from './credits.ts'
import { AuthStore, AuthManager } from './auth.ts'
import { createModelDiscoverer } from './models.ts'

export const name = 'dsh-codebuddy-link'
export const inject = ['llm', 'commands']

export function apply(ctx: Context, entry: Record<string, unknown> = {}): void {
  const store = new SettingsStore(entry)
  const config = store.config
  const runtime = new CallRuntime(config)
  const credentials = new AuthStore()
  /** The saved plugin credential is handed to every CLI child via CODEBUDDY_AUTH_TOKEN. */
  const readAuthToken = async (): Promise<string | undefined> => {
    try { return (await credentials.read())?.accessToken } catch { return undefined }
  }
  ctx.inject(['webServer'], sub => {
    const server = sub.get('webServer') as WebServerLike | undefined
    if (!server) return
    const manager = new AuthManager(credentials)
    const fileRefresh = createAccountRefresher()
    const savedRefresh = createAccountRefresher({readCredentials:async () => {
      const login = await credentials.read()
      return login ? {auth:{accessToken:login.accessToken,tokenType:'Bearer'},account:{uid:login.uid}} : undefined
    }})
    const refresh = async () => (await credentials.status()).configured ? savedRefresh() : fileRefresh()
    return registerSettingsRoutes(server, store, () => { runtime.refresh(); ctx.emit('llm/adapters-updated') }, refresh, {
      status:() => credentials.status(), import:value => manager.import(value), clear:() => manager.clear(),
      start:() => manager.start(), poll:id => manager.poll(id), cancel:id => manager.cancel(id), cancelAll:() => manager.cancelAll(),
    }, createModelDiscoverer({bin:config.codebuddyBin, readCredentials:() => credentials.read()}), () => runtime.snapshots())
  })
  const sessionCwd = (id: string): string | undefined => {
    const sessions = ctx.get('sessions') as {get(id: unknown): {header?: {cwd?: string}} | undefined} | undefined
    return sessions?.get(id)?.header?.cwd
  }
  if (config.enabled) ctx.llm.registerAdapter(['codebuddy'], new CodeBuddyAdapter(config, undefined, sessionCwd, readAuthToken, runtime))
  ctx.commands.register({
    name: 'codebuddy', description: 'CodeBuddy bridge status, models and setup',
    input: { hint: '<status|models|runs|help>' },
    handler: ({ rawInput }) => {
      const command = rawInput.trim() || 'help'
      if (command === 'runs') return { kind: 'success', text: JSON.stringify(runtime.snapshots(), null, 2) }
      if (command === 'status') return { kind: 'success', text: [
        '**CodeBuddy bridge**', `Enabled: ${config.enabled}`, `CLI: ${config.codebuddyBin || 'codebuddy (PATH)'}`,
        `Model: ${config.defaultModel}`, `Default effort: ${config.reasoningEffort} (server reasoning unconfirmed)`,
        `Concurrency: ${config.maxConcurrency}; queue timeout: ${config.queueTimeoutMs}ms; no-progress warning: ${config.stallWarnMs}ms`,
        'Execution mode: autonomous (ACP stdio, fixed)',
        `Provider transport: ACP stdio; CodeBuddy native default tools; outside DSH sandbox; skip permissions: ${config.dangerouslySkipPermissions}`,
        `Delegation tools: ${config.tools || 'disabled'} (${config.permissionMode})`,
        `Workspace: ${config.workspaceRoot || 'DSH session workspace'}`,
        'Authentication: the saved CodeBuddy plugin credential is passed to the CLI automatically; otherwise the CLI uses its own login. This status does not verify login.',
      ].join('\n') }
      if (command === 'models') return { kind: 'success', text: config.models.filter(id => !config.hiddenModels.includes(id)).map(id => `- codebuddy/${id}`).join('\n') }
      if (command !== 'help') return { kind: 'error', text: `Unknown subcommand: ${command}. Use /codebuddy help.` }
      return { kind: 'success', text: '/codebuddy status — configuration\n/codebuddy models — configured models\n/codebuddy runs — recent sanitized calls in this process\nSelect codebuddy/default in the DSH model picker. Install and sign in to the official CodeBuddy CLI first. Additional model IDs can be configured with DSH_CODEBUDDY_MODELS.' }
    },
  })
  if (!config.enabled || !config.askTool) return
  ctx.inject(['tools'], sub => {
    const tool = defineTool({
      name: 'codebuddy_ask',
      description: 'Ask CodeBuddy CLI a standalone question without changing the current DSH model. No DSH history is sent. Built-in CLI tools are disabled unless the administrator explicitly configured them; enabled CLI tools operate outside the DSH file sandbox.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'Self-contained question or task.' },
        model: { type: 'string', description: 'Exact CodeBuddy model ID, or default.' },
        reasoningEffort: { type: 'string', description: `Override thinking effort (${CODEBUDDY_EFFORTS.join(', ')}). Omit to inherit plugin default; auto uses CLI default.` },
      },
      output: { schema: {type: 'string'}, render: (_args, value) => [{type: 'text', text: value}] },
      async execute(args, exec) {
        const agent = exec.agent as unknown as {session?: {header?: {cwd?: string}}} | undefined
        const cwd = config.workspaceRoot || agent?.session?.header?.cwd
        if (config.tools && !cwd) throw new Error('Set workspaceRoot before enabling CodeBuddy delegation tools; session workspace is unavailable')
        if (!args.prompt.trim()) throw new Error('prompt must not be empty')
        if (args.prompt.length > config.maxPromptChars) throw new Error('prompt exceeds maxPromptChars')
        let text = ''; let result = ''
        const model = args.model || config.defaultModel
        if (!config.models.includes(model) || config.hiddenModels.includes(model)) throw new Error('CodeBuddy model is not enabled in settings')
        for await (const event of runtime.run({ prompt: args.prompt, cwd: cwd || process.cwd(), bin: config.codebuddyBin || undefined,
          effort: resolveEffort(args.reasoningEffort, config.reasoningEffort),
          model: model === 'default' ? undefined : model, permissionMode: config.permissionMode, tools: config.tools,
          timeoutMs: config.timeoutMs, signal: exec.signal, authToken: await readAuthToken() }, 'ask')) {
          if (event.type === 'text') text += event.delta
          if (event.type === 'result') result = event.text
        }
        return result || text
      },
    })
    // defineTool copies options; attach the live getter to the resulting definition.
    // Host timers cannot exceed signed 32-bit milliseconds.
    Object.defineProperty(tool, 'timeoutMs', { enumerable: true, get: () => Math.min(2147483647, config.timeoutMs + config.queueTimeoutMs + 5000) })
    sub.tools.register(tool)
  })
}

export { CodeBuddyAdapter, resolveConfig }
