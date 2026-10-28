import { strictJson } from './json.ts'

/** DeepSeek may emit its native DSML call serialization as plain CLI text.
 * Decode only a complete, standalone calls document; never search prose/code for
 * executable fragments. All calls still pass the bridge allowlist and DSH validation.
 */
export function parseDsml(text: string): { text: string; toolCalls: { name: string; arguments: string }[] } {
  let rest = text.trim()
  const fail = (): never => { throw new Error('Invalid CodeBuddy DSML tool calls') }
  const consume = (token: string) => {
    if (!rest.startsWith(token)) fail()
    rest = rest.slice(token.length).trimStart()
  }
  consume('<｜｜DSML｜｜ calls>')
  const calls: { name: string; arguments: string }[] = []
  while (!rest.startsWith('</｜｜DSML｜｜ calls>')) {
    if (calls.length >= 32) fail()
    const invoke = /^<｜｜DSML｜｜ invoke name="([^"<>\s]+)">/.exec(rest)
    if (!invoke) fail()
    consume(invoke![0])
    const args: Record<string, unknown> = Object.create(null)
    while (!rest.startsWith('</｜｜DSML｜｜ invoke>')) {
      const parameter = /^<｜｜DSML｜｜ parameter name="([^"<>\s]+)" string="(true|false)">/.exec(rest)
      if (!parameter) fail()
      const [, name, isString] = parameter!
      if (Object.hasOwn(args, name!)) fail()
      // Do not trim or unescape string payloads: paths, quotes, newlines and
      // shell operators are literal DSML values, not XML entities or JS strings.
      rest = rest.slice(parameter![0].length)
      const end = rest.indexOf('</｜｜DSML｜｜ parameter>')
      if (end < 0) fail()
      const value = rest.slice(0, end)
      if (value.includes('<｜｜DSML｜｜') || value.includes('</｜｜DSML｜｜')) fail()
      if (isString === 'true') args[name!] = value
      else {
        try { args[name!] = strictJson(value) } catch { fail() }
      }
      rest = rest.slice(end)
      consume('</｜｜DSML｜｜ parameter>')
    }
    consume('</｜｜DSML｜｜ invoke>')
    calls.push({ name: invoke![1]!, arguments: JSON.stringify(args) })
  }
  consume('</｜｜DSML｜｜ calls>')
  if (rest || !calls.length) fail()
  return { text: '', toolCalls: calls }
}
