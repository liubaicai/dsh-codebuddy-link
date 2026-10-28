/** Bounded model IDs, not arbitrary URLs or absolute/relative filesystem paths.
 * This validates syntax; it cannot recognize secrets disguised as valid model IDs.
 */
export function isModelIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.exec(value)?.[0] === value
    && !value.includes(':/')
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
