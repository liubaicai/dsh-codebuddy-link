/** Strict JSON with bounded nesting and duplicate-key rejection. No repair/eval. */
export function strictJson(input: string): unknown {
  const fail = (detail: string): never => { throw new Error(`Invalid CodeBuddy response envelope: ${detail}`) }
  let i = 0
  const ws = () => { while (i < input.length && /\s/.test(input[i]!)) i++ }
  const string = (): string => {
    const start = i++
    while (i < input.length) {
      const c = input[i++]
      if (c === '\\') { i++; continue }
      if (c === '"') return JSON.parse(input.slice(start, i)) as string
    }
    return fail('unterminated JSON string')
  }
  const walk = (depth: number): void => {
    if (depth > 32) fail('JSON nesting limit exceeded')
    ws()
    const c = input[i]
    if (c === '"') { string(); return }
    if (c === '{' || c === '[') {
      i++; ws()
      const end = c === '{' ? '}' : ']'
      const seen = new Set<string>()
      if (input[i] === end) { i++; return }
      while (i < input.length) {
        if (c === '{') {
          if (input[i] !== '"') fail('invalid JSON object key')
          const key = string()
          if (seen.has(key)) fail('duplicate JSON key')
          seen.add(key); ws()
          if (input[i++] !== ':') fail('invalid JSON object')
        }
        walk(depth + 1); ws()
        if (input[i] === end) { i++; return }
        if (input[i++] !== ',') fail('invalid JSON separator')
        ws()
      }
      fail('incomplete JSON')
    }
    const start = i
    while (i < input.length && !/[\s,\]}]/.test(input[i]!)) i++
    if (i === start) fail('invalid JSON value')
    const primitive: unknown = JSON.parse(input.slice(start, i))
    if (typeof primitive === 'number' && !Number.isFinite(primitive)) fail('non-finite JSON number')
  }
  try {
    walk(0); ws()
    if (i !== input.length) fail('trailing JSON data')
    return JSON.parse(input)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid CodeBuddy')) throw error
    return fail('malformed JSON')
  }
}
