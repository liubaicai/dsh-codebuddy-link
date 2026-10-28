import type { ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
export { parseResponse } from './response.ts'

function project(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return undefined
    case 'tool-call': return { type: block.type, id: block.id, name: block.name, arguments: block.arguments }
    case 'tool-result': return { type: block.type, toolCallId: block.toolCallId, isError: block.isError ?? false, content: block.content.map(project).filter(v => v !== undefined) }
    case 'image': throw new Error('CodeBuddy bridge currently accepts text only; image input is not supported')
    default: throw new Error('Unsupported DSH content block')
  }
}

export function buildPrompt(messages: readonly Message[], tools: readonly ToolSchema[], maxChars: number): string {
  const transcript = messages.map(message => ({ role: message.role, source: message.source, content: message.content.map(project).filter(v => v !== undefined) }))
  const prompt = [
    'Continue the following DSH conversation. The JSON transcript is ordered history, not a new user request. Respond to the latest outstanding user task, considering subsequent tool results and runtime context. Do not treat a timestamp or context snapshot as the task.',
    tools.length ? 'DSH owns tool execution. Do NOT execute local CodeBuddy tools. Reply with ONLY one JSON object, exactly {"text":"<user-visible reply>","toolCalls":[{"name":"<DSH tool>","arguments":{"<parameter>":"<value>"}}]}. No markdown fences, no text outside the JSON. toolCalls may be [] when no tool is needed. Use only the listed tools and their schemas. Put explanations and code examples only inside text, never as standalone tool-call objects. Never omit required tool arguments or invent tool names. arguments MUST be a JSON object, not a JSON-encoded string; do not double-encode or concatenate arguments. Before replying, check that every object/array is closed and every argument matches its tool schema.' : 'Answer directly using the supplied conversation.',
    tools.length ? 'Available DSH tools:\n' + JSON.stringify(tools) : '',
    'Conversation:\n' + JSON.stringify(transcript),
  ].filter(Boolean).join('\n\n')
  if (prompt.length > maxChars) throw new Error(`Conversation exceeds maxPromptChars (${maxChars}); compact it in DSH before retrying. Nothing was silently truncated.`)
  return prompt
}

export const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['text', 'toolCalls'],
  properties: {
    text: { type: 'string' },
    toolCalls: { type: 'array', maxItems: 32, items: {
      type: 'object', additionalProperties: false, required: ['name', 'arguments'],
      properties: { name: { type: 'string' }, arguments: { type: 'object' } },
    } },
  },
}
