/** Normalized facts. Conversion never executes tools or resolves approvals. */
export type CanonicalEvent =
  | { type: "run.start"; id: string }
  | { type: "step.start" | "step.end"; id: string }
  | { type: "run.end"; reason: string }
  | {
      type: "block.start";
      id: string;
      messageId: string;
      kind: "text" | "reasoning";
    }
  | { type: "block.delta"; id: string; text: string }
  | {
      type: "block.metadata";
      id: string;
      namespace: string;
      value: Record<string, unknown>;
    }
  | { type: "block.end"; id: string }
  | { type: "tool.start"; id: string; name: string; messageId: string }
  | { type: "tool.delta"; id: string; text: string }
  | { type: "tool.end"; id: string }
  | { type: "tool.result"; id: string; result: unknown; isError?: boolean }
  | {
      type: "usage";
      input?: number;
      output?: number;
      total?: number;
      details?: unknown;
    }
  | { type: "error"; message: string; code?: string }
  | { type: "state.snapshot"; value: unknown }
  | { type: "state.patch"; patch: unknown[] }
  | {
      type: "interaction.requested";
      id: string;
      toolCallId?: string;
      kind: "approval" | "question";
      payload: unknown;
    }
  | { type: "custom"; name: string; value: unknown }
  | { type: "opaque"; protocol: string; payload: unknown };

export type MaybePromise<T> = T | Promise<T>;
/** Native SDK unions may include newer event variants; decoders diagnose them at runtime. */
export type NativeInput<E> = E extends { type: string }
  ? { type: string }
  : E extends { object: string }
    ? { object: string }
    : E extends { event: string }
      ? { event: string; data: unknown }
      : E extends readonly [string, unknown]
        ? readonly [string, unknown]
        : E;
export type Input<T> = Iterable<T> | AsyncIterable<T> | ReadableStream<T>;
export type EventKey<E> = E extends { type: infer K extends string }
  ? K
  : E extends { object: infer K extends string }
    ? K
    : E extends { event: infer K extends string }
      ? K
      : E extends readonly [infer K extends string, unknown]
        ? K
        : never;
type EventOf<E, K> = E extends unknown
  ? K extends EventKey<E>
    ? E
    : never
  : never;
export type Middleware<E> = {
  [K in EventKey<E>]?: (
    event: EventOf<E, K>,
  ) => MaybePromise<E | readonly E[] | null>;
};
/** Ask an override to use the built-in conversion for this source event. */
export const DEFAULT = Symbol("eventport.DEFAULT");
export type Overrides<I, O> = {
  [K in EventKey<I>]?: (
    event: EventOf<I, K>,
  ) => MaybePromise<O | readonly O[] | null | typeof DEFAULT>;
};
export interface TargetHooks<I, O> extends Hooks<O> {
  overrides?: Overrides<I, O>;
}
export interface Hooks<E> {
  middleware?: Middleware<E>;
}
export interface Diagnostic {
  stage: "decode" | "encode";
  adapter: string;
  event: unknown;
  reason: string;
}
export type UnsupportedPolicy =
  | "error"
  | "drop"
  | ((diagnostic: Diagnostic) => MaybePromise<"drop" | "error">);
export interface Context {
  signal?: AbortSignal;
  unsupported(event: unknown, reason: string): Promise<void>;
}
export interface Decoder<E> {
  push(event: E): MaybePromise<readonly CanonicalEvent[]>;
  finish(): MaybePromise<readonly CanonicalEvent[]>;
}
export interface Encoder<E> {
  push(event: CanonicalEvent): MaybePromise<readonly E[]>;
  finish(): MaybePromise<readonly E[]>;
}
export interface SourceAdapter<E> {
  readonly name: string;
  key(event: E): string;
  /** Distinguish array-valued native events from middleware event lists. */
  isEvent?(value: unknown): value is E;
  decoder(context: Context): Decoder<E>;
}
export interface TargetAdapter<E> {
  readonly name: string;
  key(event: E): string;
  /** Distinguish array-valued native events from middleware event lists. */
  isEvent?(value: unknown): value is E;
  encoder(context: Context): Encoder<E>;
  wire: {
    headers?: Record<string, string>;
    frame(event: E): string;
    end?: string;
  };
}
export type Adapter<E> = SourceAdapter<E> & TargetAdapter<E>;
