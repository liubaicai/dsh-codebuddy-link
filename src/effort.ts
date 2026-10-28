import { isCodeBuddyEffort, type CodeBuddyEffort } from './config.ts'

/** An explicit auto uses the CLI default; omission inherits the plugin default. */
export function resolveEffort(value: unknown, fallback: string): CodeBuddyEffort | undefined {
  const selected = value === undefined ? fallback : value
  if (selected === 'auto') return undefined
  if (!isCodeBuddyEffort(selected)) throw new Error('Unsupported reasoning effort')
  return selected
}
