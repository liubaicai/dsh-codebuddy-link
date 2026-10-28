/** Bounded model IDs, not arbitrary URLs or absolute/relative filesystem paths.
 * This validates syntax; it cannot recognize secrets disguised as valid model IDs.
 */
export declare function isModelIdentifier(value: unknown): value is string;
