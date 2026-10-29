import type { BridgeEvent } from './protocol.ts';
/** CodeBuddy 2.177.1 ACP extensions. Context used/size are NOT billable usage. */
export declare class AcpUsage {
    private messages;
    private credits;
    accept(value: unknown): BridgeEvent[];
}
