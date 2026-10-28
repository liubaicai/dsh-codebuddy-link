import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type ReasoningEffortId, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { CODEBUDDY_EFFORTS, type CodeBuddyEffort, type PluginConfig } from './config.ts'
import { resolveEffort } from './effort.ts'
import { CallRuntime } from './runtime.ts'
import { buildPrompt, parseResponse } from './prompt.ts'
import { runCodeBuddy } from './runner.ts'

export type Runner = typeof runCodeBuddy

export { CODEBUDDY_EFFORTS, type CodeBuddyEffort } from './config.ts';
const EFFORT_LABELS: Record<CodeBuddyEffort, string> = { auto: 'CLI 默认', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大', ultracode: 'ultracode' };
export class CodeBuddyAdapter extends LlmAdapter {
  private readonly config: PluginConfig
  private readonly runner: Runner
  private readonly sessionCwd: (id: string) => string | undefined
  private readonly authToken: (() => Promise<string | undefined>) | undefined
  private readonly runtime: CallRuntime
  constructor(config: PluginConfig, runner: Runner = runCodeBuddy, sessionCwd: (id: string) => string | undefined = () => undefined, authToken?: () => Promise<string | undefined>, runtime = new CallRuntime(config)) {
    super(); this.config = config; this.runner = runner; this.sessionCwd = sessionCwd; this.authToken = authToken; this.runtime = runtime
  }
  /** Saved plugin credential, when present and readable, authenticates the CLI child. */
  private async resolveAuthToken(): Promise<string | undefined> {
    if (!this.authToken) return undefined
    try { return await this.authToken() } catch { return undefined }
  }
  override providerInfo() { return { id: 'codebuddy', name: 'CodeBuddy CLI' } }
  override async listModels(): Promise<readonly LlmModelInfo[]> {
    return this.config.models.filter(id => !this.config.hiddenModels.includes(id)).map(id => ({ provider: 'codebuddy', id, name: id === 'default' ? 'CodeBuddy (CLI default)' : id, inputModalities: ['text'] }))
  }
  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider: 'codebuddy', id: model, name: model === 'default' ? 'CodeBuddy (CLI default)' : model, inputModalities: ['text'],
      context: { contextWindow: model === 'default' ? this.config.contextWindow : (this.config.modelContext[model] ?? this.config.contextWindow) },
      // Exposing reasoning efforts makes DSH render its 思考等级 picker; the
      // chosen value flows back as options.reasoningEffort into --effort.
      reasoning: { efforts: CODEBUDDY_EFFORTS.map(id => ({ id: id as ReasoningEffortId, name: id === 'ultracode' ? id : `${id} ${EFFORT_LABELS[id]}` })) },
    }
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted')
    return { model: await this.resolveModel(provider, model), stream: (options: GenerateOptions) => this.stream({ ...options, provider, model, signal: options.signal ?? signal }) }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const cfg = this.config
    if (!cfg.enabled) throw new Error('CodeBuddy bridge is disabled')
    const selectedModel = options.model || cfg.defaultModel
    if (!cfg.models.includes(selectedModel) || cfg.hiddenModels.includes(selectedModel)) throw new Error('CodeBuddy model is not enabled in settings')
    const tools = options.purpose ? [] : options.tools ?? []
    const structured = tools.length > 0
    const cwd = cfg.workspaceRoot || (options.sessionId ? this.sessionCwd(options.sessionId) : undefined) || process.cwd()
    if (!isAbsolute(cwd)) throw new Error('CodeBuddy workspace must be an absolute path')
    const prompt = buildPrompt(options.messages, tools, cfg.maxPromptChars)
    let index = 0
    let open: 'text' | 'reasoning' | undefined
    let accumulated = ''
    let rawText = ''
    let resultText = ''
    let structuredOutput: unknown
    let usage: TokenUsage | undefined
    let sessionId: string | undefined
    const close = (): StreamChunk[] => {
      if (!open) return []
      const chunk: StreamChunk = { type: 'block-end', index, block: { type: open, text: accumulated } }
      open = undefined; accumulated = ''; index++
      return [chunk]
    }
    const append = (type: 'text' | 'reasoning', text: string): StreamChunk[] => {
      if (!text) return []
      const chunks: StreamChunk[] = []
      if (open !== type) {
        chunks.push(...close()); open = type
        chunks.push({ type: 'block-start', index, blockType: type })
      }
      accumulated += text
      chunks.push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index, text })
      return chunks
    }
    try {
      // Structured replies are requested via the prompt envelope, NOT the CLI's
      // --json-schema flag: measured on CLI 2.177.1, that mode inflates billed
      // input ~4-8x (a 34K-token surface became 315K), triples wall time and is
      // unreliable (sometimes refuses the internal StructuredOutput tool), while
      // the prompt envelope yields valid JSON at plain-mode speed and cost.
      for await (const event of this.runtime.run({
        prompt, systemPrompt: options.system, cwd, bin: cfg.codebuddyBin || undefined,
        model: (options.model || cfg.defaultModel) === 'default' ? undefined : (options.model || cfg.defaultModel),
        effort: resolveEffort(options.reasoningEffort, cfg.reasoningEffort), permissionMode: 'dontAsk', tools: '',
        timeoutMs: cfg.timeoutMs, signal: options.signal, authToken: await this.resolveAuthToken(),
      }, 'model', this.runner, structured ? event => {
        parseResponse(event.structuredOutput ?? (event.text || rawText), tools)
      } : undefined)) {
        if (event.type === 'text') {
          rawText += event.delta
          if (!structured) yield* append('text', event.delta)
        } else if (event.type === 'reasoning' && !structured) yield* append('reasoning', event.delta)
        else if (event.type === 'usage') usage = { inputTokens: event.input, outputTokens: event.output, cacheReadTokens: event.cacheRead, cacheWriteTokens: event.cacheWrite }
        else if (event.type === 'result') { sessionId = event.sessionId; resultText = event.text; structuredOutput = event.structuredOutput }
      }
      if (structured) {
        const response = parseResponse(structuredOutput ?? (resultText || rawText), tools)
        yield* append('text', response.text)
        yield* close()
        for (const call of response.toolCalls) {
          const id = ToolCallId('codebuddy-' + randomUUID())
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } }
          index++
        }
        if (usage) yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: response.toolCalls.length ? 'tool-calls' : 'stop' }, replayState: { response: { sessionId: sessionId ?? null } } }
      } else {
        if (!rawText && resultText) yield* append('text', resultText)
        yield* close()
        if (usage) yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { sessionId: sessionId ?? null } } }
      }
    } catch (error) {
      yield* close()
      if (usage) yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: options.signal?.aborted ? 'aborted' : 'error', failure: { code: options.signal?.aborted ? 'ABORTED' : 'CODEBUDDY_ERROR', message: error instanceof Error ? error.message : String(error) } } }
    }
  }
}
