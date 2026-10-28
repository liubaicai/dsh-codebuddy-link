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
}
export declare function apply(ctx: ClientContext): void;
