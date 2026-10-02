import type {
  CanonicalEvent,
  Context,
  Diagnostic,
  Hooks,
  Input,
  NativeInput,
  SourceAdapter,
  TargetAdapter,
  UnsupportedPolicy,
} from "./types.js";

export class UnsupportedEventError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(`${diagnostic.adapter} (${diagnostic.stage}): ${diagnostic.reason}`);
    this.name = "UnsupportedEventError";
  }
}

function check(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  check(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

function readableIterator<T>(stream: ReadableStream<T>): AsyncIterator<T> {
  const reader = stream.getReader();
  return {
    async next() {
      const n = await reader.read();
      if (n.done) reader.releaseLock();
      return n as IteratorResult<T>;
    },
    async return() {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
      return { done: true, value: undefined };
    },
  };
}

async function* read<T>(
  input: Input<T>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const iterator: AsyncIterator<T> | Iterator<T> =
    "getReader" in input
      ? readableIterator(input)
      : Symbol.asyncIterator in input
        ? input[Symbol.asyncIterator]()
        : input[Symbol.iterator]();
  let done = false;
  try {
    while (true) {
      check(signal);
      const next = await abortable(Promise.resolve(iterator.next()), signal);
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!done && iterator.return) {
      const closing = Promise.resolve(iterator.return());
      // SDK calls must also receive the app's abort signal to stop network work.
      if (signal?.aborted) void closing.catch(() => {});
      else await closing;
    }
  }
}

async function apply<E>(
  event: E,
  adapter: { key(event: E): string },
  hooks: Hooks<E>,
): Promise<readonly E[]> {
  const handlers = hooks.middleware as
    | Record<string, (event: E) => unknown>
    | undefined;
  const fn = handlers?.[adapter.key(event)];
  const output = fn ? await fn(event) : event;
  if (output === undefined)
    throw new TypeError(
      "Middleware must return an event, an array, or null; received undefined.",
    );
  const events =
    output === null ? [] : Array.isArray(output) ? output : [output as E];
  for (const value of events) await hooks.observe?.(value);
  return events;
}

/** Lazy and single-use. Construct another conversion to replay an array. */
export class Conversion<I, O> implements AsyncIterable<O> {
  private policy: UnsupportedPolicy = "error";
  private started = false;
  constructor(
    private input: Input<I>,
    private source: SourceAdapter<I>,
    private sourceHooks: Hooks<I>,
    private target: TargetAdapter<O>,
    private targetHooks: Hooks<O>,
    private signal?: AbortSignal,
  ) {}

  onUnsupported(policy: UnsupportedPolicy): this {
    if (this.started)
      throw new Error(
        "Configure unsupported handling before consuming the conversion.",
      );
    this.policy = policy;
    return this;
  }

  private context(
    stage: Diagnostic["stage"],
    adapter: string,
    signal?: AbortSignal,
  ): Context {
    return {
      signal,
      unsupported: async (event, reason) => {
        const diagnostic = { stage, adapter, event, reason };
        const decision =
          typeof this.policy === "function"
            ? await this.policy(diagnostic)
            : this.policy;
        if (decision !== "drop") throw new UnsupportedEventError(diagnostic);
      },
    };
  }

  private async *iterate(signal?: AbortSignal): AsyncGenerator<O> {
    if (this.started)
      throw new Error(
        "Conversions are single-use; create a new conversion to replay input.",
      );
    this.started = true;
    const decoder = this.source.decoder(
      this.context("decode", this.source.name, signal),
    );
    const encoder = this.target.encoder(
      this.context("encode", this.target.name, signal),
    );
    const output = async (event: CanonicalEvent) => {
      check(signal);
      const result: O[] = [];
      for (const value of await encoder.push(event))
        result.push(...(await apply(value, this.target, this.targetHooks)));
      return result;
    };
    for await (const original of read(this.input, signal)) {
      for (const event of await apply(
        original,
        this.source,
        this.sourceHooks,
      )) {
        check(signal);
        for (const canonical of await decoder.push(event))
          yield* await output(canonical);
      }
    }
    check(signal);
    for (const canonical of await decoder.finish())
      yield* await output(canonical);
    for (const value of await encoder.finish())
      yield* await apply(value, this.target, this.targetHooks);
  }

  [Symbol.asyncIterator](): AsyncIterator<O> {
    return this.iterate(this.signal);
  }

  async collect(): Promise<O[]> {
    const result: O[] = [];
    for await (const event of this) result.push(event);
    return result;
  }

  toReadableStream(): ReadableStream<O> {
    const controller = new AbortController();
    const signal = this.signal
      ? AbortSignal.any([this.signal, controller.signal])
      : controller.signal;
    const iterator = this.iterate(signal);

    return new ReadableStream<O>(
      {
        async pull(sink) {
          try {
            const next = await iterator.next();
            if (next.done) sink.close();
            else sink.enqueue(next.value);
          } catch (error) {
            sink.error(error);
          }
        },
        async cancel(reason) {
          controller.abort(
            reason ?? new DOMException("Cancelled", "AbortError"),
          );
          await iterator.return(undefined);
        },
      },
      { highWaterMark: 0 },
    );
  }

  toResponse(init: ResponseInit = {}): Response {
    const encoder = new TextEncoder();
    const wire = this.target.wire;
    const body = this.toReadableStream().pipeThrough(
      new TransformStream<O, Uint8Array>({
        transform(event, sink) {
          sink.enqueue(encoder.encode(wire.frame(event)));
        },
        flush(sink) {
          if (wire.end) sink.enqueue(encoder.encode(wire.end));
        },
      }),
    );
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "text/event-stream; charset=utf-8");
    headers.set("Cache-Control", "no-cache");
    for (const [key, value] of Object.entries(wire.headers ?? {}))
      headers.set(key, value);
    return new Response(body, { ...init, headers });
  }
}

export const eventport = {
  convert<I>(input: Input<I>, options: { signal?: AbortSignal } = {}) {
    return {
      from<S>(
        source: SourceAdapter<S> &
          ([I] extends [NativeInput<S>] ? unknown : { readonly incompatibleInput: never }),
        hooks: NoInfer<Hooks<S>> = {},
      ) {
        return {
          to<O>(
            target: TargetAdapter<O>,
            targetHooks: NoInfer<Hooks<O>> = {},
          ): Conversion<S, O> {
            return new Conversion(
              input as unknown as Input<S>,
              source,
              hooks,
              target,
              targetHooks,
              options.signal,
            );
          },
        };
      },
    };
  },
};
