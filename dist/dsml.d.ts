/** DeepSeek may emit its native DSML call serialization as plain CLI text.
 * Decode only a complete, standalone calls document; never search prose/code for
 * executable fragments. All calls still pass the bridge allowlist and DSH validation.
 */
export declare function parseDsml(text: string): {
    text: string;
    toolCalls: {
        name: string;
        arguments: string;
    }[];
};
