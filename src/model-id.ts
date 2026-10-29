/** Model IDs are protocol identifiers, not URLs or filesystem paths. */
export const MAX_MODEL_ID_LENGTH = 256

/** CLI requests and configured/discovered candidates use bare model IDs only. */
export function isRequestModelIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_MODEL_ID_LENGTH
    && !/^[a-zA-Z]:/.test(value)
    && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.exec(value)?.[0] === value
}

/** Returned metadata may additionally identify a model as exactly provider/name.
 * Syntax validation cannot recognize secrets disguised as valid identifiers.
 */
export function isReturnedModelIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_MODEL_ID_LENGTH) return false
  const parts = value.split('/')
  return (parts.length === 1 || parts.length === 2)
    && parts.every(isRequestModelIdentifier)
    && !value.includes(':/')
}
