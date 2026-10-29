type JsonObject = Record<string, unknown>;
/**
 * Non-executing ACP session metadata may precede session/new's response or
 * follow session/prompt's response.
 * Keep this allowlist explicit: message/tool/plan events are not metadata, and
 * unknown updates must not silently acquire permission to cross that boundary.
 * Shapes follow the ACP SessionUpdate schema; extension payloads stay opaque.
 */
export declare function isSessionMetadata(row: JsonObject): boolean;
export {};
