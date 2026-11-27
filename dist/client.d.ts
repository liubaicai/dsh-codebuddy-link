export declare const name = "dsh-codebuddy-link-client";
export declare const inject: string[];
export interface ClientContext {
    slots: {
        inject(name: string, register: () => () => void): void;
        register(options: {
            name: string;
            id?: string;
            key?: string;
            order?: number;
            label?: string;
        }, component: (props?: unknown) => unknown): () => void;
    };
    inject?(services: readonly ['uiConversation'], callback: (scope: ClientContext & {
        uiConversation: {
            events: {
                register(definition: typeof progressDefinition): () => void;
            };
        };
    }) => void): void;
}
declare const progressKind = "codebuddy-link-progress";
type StepEvent = {
    seq: number;
    data: {
        turn: number;
        step: number;
    };
};
type ProgressChunk = {
    type: string;
    blockType?: string;
    codebuddyProgress?: true;
    text?: string;
};
type LiveEvent = StepEvent & {
    type: 'assistant/live-chunk';
    data: {
        attemptId: string;
        chunk: ProgressChunk;
    };
};
type SettlementEvent = StepEvent & {
    type: 'assistant/message';
    data: {
        stream?: readonly {
            chunk?: ProgressChunk;
        }[];
    };
};
type ProgressMatch = {
    event: LiveEvent | SettlementEvent;
    location: {
        kind: string;
        turn?: {
            status: string;
        };
        step?: {
            status: string;
        };
    };
};
type ProgressState = {
    attemptId: string;
    text: string;
    settled: boolean;
};
type ProgressContext = {
    key: string;
    id: string;
    start?: ProgressMatch;
    state?: ProgressState;
    current: ReadonlyMap<string, ProgressNode>;
};
type ProgressNode = {
    key: string;
    id: string;
    kind: typeof progressKind;
    target: 'chat';
    groupTree: 'process';
    anchorSeq: number;
    location: ProgressMatch['location'];
    visibility: 'hidden' | 'visible';
    data: {
        text: string;
    };
};
declare const progressDefinition: {
    kind: string;
    target: string;
    match: {
        'assistant/live-chunk': (event: LiveEvent) => {
            id: string;
            role: string;
        } | null;
        'assistant/message': (event: SettlementEvent) => {
            id: string;
            role: string;
        } | null;
    };
    start: (_context: unknown, { event }: {
        event: LiveEvent;
    }) => ProgressState;
    update: ({ state }: {
        state: ProgressState;
    }, { event }: ProgressMatch) => ProgressState;
    publication: (match: ProgressMatch) => "animation-frame" | "immediate";
    buildViewNode: (context: ProgressContext) => ProgressNode | null;
};
export declare function apply(ctx: ClientContext): void;
export {};
