import { isAbsolute } from 'node:path'
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type ReasoningEffortId, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { CODEBUDDY_EFFORTS, type CodeBuddyEffort, type PluginConfig } from './config.ts'
import { resolveEffort } from './effort.ts'
import { CallRuntime } from './runtime.ts'
import { autonomousSystemPrompt, buildPrompt, buildSystemPrompt } from './prompt.ts'
import { runCodeBuddy } from './runner.ts'
import { runCodeBuddyAcp } from './acp.ts'

export type Runner = typeof runCodeBuddy

export { CODEBUDDY_EFFORTS, type CodeBuddyEffort } from './config.ts';
const EFFORT_LABELS: Record<CodeBuddyEffort, string> = { auto: 'CLI 默认', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大', ultracode: 'ultracode' };
export class CodeBuddyAdapter extends LlmAdapter {
  private readonly config: PluginConfig
  private readonly runner: Runner | undefined
  private readonly sessionCwd: (id: string) => string | undefined
  private readonly authToken: (() => Promise<string | undefined>) | undefined
  private readonly runtime: CallRuntime
  constructor(config: PluginConfig, runner: Runner | undefined = undefined, sessionCwd: (id: string) => string | undefined = () => undefined, authToken?: () => Promise<string | undefined>, runtime = new CallRuntime(config)) {
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
    // Host housekeeping (titles/compaction/etc.) must never acquire native tools.
    const autonomous = !options.purpose
    const workspace = cfg.workspaceRoot || (options.sessionId ? this.sessionCwd(options.sessionId) : undefined)
    if (autonomous && !workspace) throw new Error('CodeBuddy autonomous execution requires a session workspace or explicit workspaceRoot')
    const cwd = workspace || process.cwd()
    if (!isAbsolute(cwd)) throw new Error('CodeBuddy workspace must be an absolute path')
    const prompt = buildPrompt(options.messages, [], cfg.maxPromptChars, autonomous)
    let index = 0
    let open: 'text' | 'reasoning' | undefined
    let accumulated = ''
    let rawText = ''
    // Keep a small live preview, not a second full copy of a long final answer.
    let previewRemaining = 1024
    let previewTruncated = false
    let resultText = ''
    let partialSuccess = false
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
      // Native ACP operations are executed by the CLI. Never request or parse
      // DSH tool envelopes, including for restricted housekeeping calls.
      for await (const event of this.runtime.run({
        prompt, sessionId: options.sessionId,
        // Keep CodeBuddy's native system prompt/tool guidance in autonomous mode.
        ...(autonomous ? { appendSystemPrompt: autonomousSystemPrompt(options.system) } : { systemPrompt: buildSystemPrompt(options.system, false) }),
        cwd, bin: cfg.codebuddyBin || undefined,
        model: (options.model || cfg.defaultModel) === 'default' ? undefined : (options.model || cfg.defaultModel),
        effort: resolveEffort(options.reasoningEffort, cfg.reasoningEffort),
        permissionMode: autonomous ? cfg.permissionMode : 'dontAsk', tools: autonomous ? 'default' : '',
        ...(autonomous ? { dangerouslySkipPermissions: cfg.dangerouslySkipPermissions } : {}),
        timeoutMs: cfg.timeoutMs, signal: options.signal, authToken: await this.resolveAuthToken(),
      }, 'model', this.runner ?? (autonomous ? runCodeBuddyAcp : runCodeBuddy))) {
        if (event.type === 'text') {
          rawText += event.delta
          if (!autonomous) yield* append('text', event.delta)
          else {
            let end = Math.min(event.delta.length, previewRemaining)
            // Do not split a UTF-16 surrogate pair at the preview boundary.
            if (end > 0 && (end < event.delta.length || end === previewRemaining) && /[\uD800-\uDBFF]/.test(event.delta[end - 1]!)) end--
            if (end) yield* append('reasoning', event.delta.slice(0, end))
            previewRemaining -= end
            if (end < event.delta.length && !previewTruncated) {
              previewRemaining = 0; previewTruncated = true
              yield* append('reasoning', '\n[CodeBuddy 正在生成，完整内容将在完成后显示]\n')
            }
          }
        } else if (event.type === 'reasoning') yield* append('reasoning', event.delta)
        else if (autonomous && (event.type === 'tool-start' || event.type === 'tool-end')) {
          // Progress only: never replay a native CLI operation as a DSH tool call,
          // and never expose tool arguments/results as diagnostic metadata.
          const name = event.name && /^[\w.-]{1,100}$/.test(event.name) ? event.name : 'native-tool'
          yield* append('reasoning', `\n[CodeBuddy ${event.type === 'tool-start' ? '执行' : event.isError ? '失败' : '完成'}: ${name}]\n`)
        }
        else if (event.type === 'usage') usage = { inputTokens: event.input, outputTokens: event.output, cacheReadTokens: event.cacheRead, cacheWriteTokens: event.cacheWrite }
        else if (event.type === 'result') { sessionId = event.sessionId; resultText = event.text; partialSuccess = event.partialSuccess === true }
      }
      // Put the fixed warning in the visible final answer, not only the collapsed
      // reasoning preview. Never expose upstream error text or replay native work.
      if (autonomous && partialSuccess) yield* append('text', '> CodeBuddy 部分成功：执行过程中出现错误，以下为已生成的答案，请核对相关结论。\n\n')
      if (autonomous) yield* append('text', resultText || rawText)
      else if (!rawText && resultText) yield* append('text', resultText)
      yield* close()
      if (usage) yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { sessionId: sessionId ?? null } } }
    } catch (error) {
      yield* close()
      if (usage) yield { type: 'usage', usage }
      const message = error instanceof Error ? error.message : String(error)
      yield { type: 'finish', reason: { kind: options.signal?.aborted ? 'aborted' : 'error', failure: { code: options.signal?.aborted ? 'ABORTED' : 'CODEBUDDY_ERROR', message } } }
    }
  }
}
