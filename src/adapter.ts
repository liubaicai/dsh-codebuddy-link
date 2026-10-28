import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type ReasoningEffortId, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { CODEBUDDY_EFFORTS, type CodeBuddyEffort, type PluginConfig } from './config.ts'
import { resolveEffort } from './effort.ts'
import { CallRuntime } from './runtime.ts'
import { buildPrompt, buildSystemPrompt, parseResponse } from './prompt.ts'
import { runCodeBuddy } from './runner.ts'

export type Runner = typeof runCodeBuddy

/** Display only model output, never prompts, credentials, stderr or raw transport events.
 * A longer-than-content Markdown fence prevents model-supplied fences/HTML from
 * turning this diagnostic into rendered instructions. Failure remains terminal. */
function failedResponseText(resultText: string, streamedText: string, structuredOutput: unknown): string {
  const sections: string[] = ['CodeBuddy 响应解析失败。本次未执行任何工具调用。以下是完整原始回复，仅供排查；分享前请检查敏感信息。']
  const fence = (label: string, value: string) => {
    let length = 3
    for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
    const marker = '`'.repeat(length)
    sections.push(`${label}\n\n${marker}text\n${value}\n${marker}`)
  }
  const body = resultText || streamedText
  if (body) fence('原始回复', body)
  if (structuredOutput !== undefined && structuredOutput !== null) {
    // structured_output is already decoded by NDJSON; show a lossless JSON
    // representation of that value, not a claimed copy of transport bytes.
    try {
      const serialized = typeof structuredOutput === 'string' ? structuredOutput : JSON.stringify(structuredOutput, null, 2)
      if (serialized !== undefined && serialized !== body) fence('结构化返回值（解析输入）', serialized)
    } catch {
      sections.push('结构化返回值无法序列化；保留原解析错误。')
    }
  }
  if (!body && structuredOutput == null) sections.push('原始回复为空。')
  return sections.join('\n\n')
}

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
    let parseFailed = false
    const parse = (value: unknown) => {
      try { return parseResponse(value, tools) }
      catch (error) { parseFailed = true; throw error }
    }
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
      // Request independent JSON records through the transport contract, NOT
      // --json-schema: on CLI 2.177.1 that mode inflated billed input ~4-8x
      // and sometimes refused its internal StructuredOutput tool. Prompting is
      // not constrained decoding: malformed responses still fail atomically.
      for await (const event of this.runtime.run({
        prompt, systemPrompt: buildSystemPrompt(options.system, structured), cwd, bin: cfg.codebuddyBin || undefined,
        model: (options.model || cfg.defaultModel) === 'default' ? undefined : (options.model || cfg.defaultModel),
        effort: resolveEffort(options.reasoningEffort, cfg.reasoningEffort), permissionMode: 'dontAsk', tools: '',
        timeoutMs: cfg.timeoutMs, signal: options.signal, authToken: await this.resolveAuthToken(),
      }, 'model', this.runner, structured ? event => {
        // Validation runs before the runtime yields result: retain the exact
        // parse input first so failed validation cannot hide the final reply.
        resultText = event.text; structuredOutput = event.structuredOutput
        parse(structuredOutput ?? (resultText || rawText))
      } : undefined)) {
        if (event.type === 'text') {
          rawText += event.delta
          if (!structured) yield* append('text', event.delta)
        } else if (event.type === 'reasoning' && !structured) yield* append('reasoning', event.delta)
        else if (event.type === 'usage') usage = { inputTokens: event.input, outputTokens: event.output, cacheReadTokens: event.cacheRead, cacheWriteTokens: event.cacheWrite }
        else if (event.type === 'result') { sessionId = event.sessionId; resultText = event.text; structuredOutput = event.structuredOutput }
      }
      if (structured) {
        const response = parse(structuredOutput ?? (resultText || rawText))
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
      const diagnostic = parseFailed && !options.signal?.aborted ? failedResponseText(resultText, rawText, structuredOutput) : ''
      if (diagnostic) {
        yield* append('text', diagnostic)
        yield* close()
      }
      if (usage) yield { type: 'usage', usage }
      // Error finishes can move streamed text into a hidden assistant/attempt.
      // Put the same complete diagnostic in the error channel the host displays.
      const message = [error instanceof Error ? error.message : String(error), diagnostic].filter(Boolean).join('\n\n')
      yield { type: 'finish', reason: { kind: options.signal?.aborted ? 'aborted' : 'error', failure: { code: options.signal?.aborted ? 'ABORTED' : 'CODEBUDDY_ERROR', message } } }
    }
  }
}
