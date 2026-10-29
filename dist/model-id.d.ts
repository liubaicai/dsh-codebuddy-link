/** Model IDs are protocol identifiers, not URLs or filesystem paths. */
export declare const MAX_MODEL_ID_LENGTH = 256;
/** CLI requests and configured/discovered candidates use bare model IDs only. */
export declare function isRequestModelIdentifier(value: unknown): value is string;
/** Returned metadata may additionally identify a model as exactly provider/name.
 * Syntax validation cannot recognize secrets disguised as valid identifiers.
 */
export declare function isReturnedModelIdentifier(value: unknown): value is string;
