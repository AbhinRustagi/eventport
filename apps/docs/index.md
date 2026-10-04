# Eventport

Typed adapters for converting AI events between protocols, on the server or in the browser. Import the adapters you use; the library has zero runtime dependencies and bundles the upstream event types.

```ts
import { eventport } from "eventport";
import { responses } from "eventport/openai";
import { agUI } from "eventport/agui";

const output = eventport
  .from(responses())
  .to(agUI({ threadId, runId }))
  .convert(upstream);
```

Your app calls the provider. Eventport converts its decoded events. It does not make model requests or execute tools.

## Get started

Install Eventport in your app:

```sh
pnpm add eventport
```

Eventport ships as ESM JavaScript with bundled TypeScript declarations. Import the adapters you need from their subpaths. Provider SDKs are only needed if your app uses them to call a provider.

Here is a complete conversion using recorded AI SDK events:

```ts
import { eventport } from "eventport";
import { aiSDK, type AISDKEvent } from "eventport/vercel";
import { agUI } from "eventport/agui";

const events: AISDKEvent[] = [
  { type: "start", messageId: "message-1" },
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: "Hello!" },
  { type: "text-end", id: "text-1" },
  { type: "finish", finishReason: "stop" },
];

const converted = await eventport
  .from(aiSDK())
  .to(agUI({ threadId: "thread-1", runId: "run-1" }))
  .convert(events)
  .collect();
```

## Adapters

| Import                | Factory                     | Source                        | Destination |
| --------------------- | --------------------------- | ----------------------------- | ----------- |
| `eventport/openai`    | `chatCompletions()`         | Chat Completions chunks       | Yes         |
| `eventport/openai`    | `responses()`               | Responses events              | Yes         |
| `eventport/anthropic` | `anthropic()`               | Anthropic Messages events     | Yes         |
| `eventport/agui`      | `agUI({ threadId, runId })` | AG-UI events                  | Yes         |
| `eventport/vercel`    | `aiSDK()`                   | AI SDK UI message chunks      | Yes         |
| `eventport/langgraph` | `langGraph()`               | LangGraph SDK event envelopes | No          |

`aiSDK()` accepts the **UI message stream**, not Core `fullStream`. `anthropic()` supports the Messages API, not Claude Agent SDK. For named LangGraph tuples, use `langGraph({ input: "tuples" })`.

Adapters support a subset of each protocol. See the [coverage matrix](https://github.com/AbhinRustagi/eventport/blob/main/packages/eventport/docs/coverage.md) for reasoning, tool calls, approvals, state, and unsupported variants.

## Live and stored events

The same pipeline accepts arrays, synchronous or asynchronous iterables, and `ReadableStream` objects. Supply decoded native events in order, with their lifecycle boundaries. Raw SSE bytes and completed message documents are not accepted.

Choose how to consume the conversion:

| Method                              | Result                                                 |
| ----------------------------------- | ------------------------------------------------------ |
| `for await (const event of output)` | Incremental destination events                         |
| `await output.collect()`            | An array of destination events                         |
| `output.toReadableStream()`         | A stream of destination event objects                  |
| `output.toResponse()`               | An SSE `Response` with destination headers and framing |

Conversion is lazy and single-use. Create another pipeline to replay recorded events. `.collect()` stores the whole output in memory.

## Typed middleware

Middleware keys and event payloads follow the selected adapter. Source hooks run before decoding; destination hooks run after encoding.

```ts
const output = eventport
  .from(responses())
  .middleware({
    "response.output_text.delta": (event) => ({
      ...event,
      delta: event.delta.toUpperCase(),
    }),
  })
  .to(agUI({ threadId, runId }))
  .convert(upstream);
```

Return an event, an array of events, or `null` to drop one. Returning `undefined` is an error. Hooks are awaited in order.

Keep lifecycle events consistent: dropping a start while retaining its deltas makes the stream invalid. Operations that match text across chunks need application-managed state.

## Overrides

Use `.overrides()` after `.to()` to replace the destination events emitted for a source event. Keys and callback arguments follow the source adapter; return values follow the destination adapter.

```ts
const converter = eventport
  .from(responses())
  .to(agUI({ threadId, runId }))
  .overrides({
    "response.output_text.delta": (event) => ({
      type: "CUSTOM",
      name: "text.fragment",
      value: { text: event.delta },
    }),
  });

const output = converter.convert(upstream);
```

Return a destination event or array to replace the built-in output, `null` to suppress it, or `eventport.DEFAULT` to keep normal conversion. Async handlers are supported; `undefined` is rejected. Source middleware runs before the override; destination middleware sees only the selected output.

The built-in decoder and encoder still update their state. An explicit replacement handles unsupported-event diagnostics for that source event, but does not bypass malformed lifecycle errors. Finalization output is not overridden. Replacements do not update the encoder's stored content or IDs, so later snapshots still reflect the original conversion. Your replacement must keep the destination sequence valid, including any start/end events produced by the same source event.

## Reusable configuration

`.from()` creates a source builder; `.to()` selects the destination. `.middleware()` applies to the selected side at that point. Configuration methods return new builders; they do not mutate earlier configurations. Repeated middleware/override calls merge handlers, with the newest handler winning for the same key.

```ts
const converter = eventport.from(responses()).to(aiSDK());
const upperCase = converter.middleware({
  "text-delta": (event) => ({ ...event, delta: event.delta.toUpperCase() }),
});

const original = converter.convert(upstream);
const replay = upperCase.convert(storedEvents);
```

Each `.convert(input, { signal })` creates fresh decoder and encoder state, and returns a lazy, single-use run. Builders can be reused concurrently; mutable state captured inside your own callbacks remains your responsibility. Keep run-specific adapter options such as AG-UI IDs distinct when separate runs need distinct identities.

The earlier `eventport.convert(input).from(source).to(target)` entry point remains available for compatibility, but is deprecated. New code should configure the converter first.

## Server and assistant-ui

An assistant-ui client can use its standard AI SDK transport. Convert the provider stream to `aiSDK()` in the server route:

```ts
import OpenAI from "openai";
import { eventport } from "eventport";
import { responses } from "eventport/openai";
import { aiSDK } from "eventport/vercel";

const client = new OpenAI(); // Reads OPENAI_API_KEY on the server.

export async function POST(request: Request) {
  const upstream = await client.responses.create(
    { model: "gpt-4.1-mini", input: "Say hello.", stream: true },
    { signal: request.signal },
  );

  return eventport
    .from(responses())
    .to(aiSDK())
    .convert(upstream, { signal: request.signal })
    .toResponse();
}
```

Install `openai` in the server app for this example. Pass the same abort signal to the provider SDK and Eventport so cancellation stops both the network request and conversion.

The [assistant-ui example app](https://github.com/AbhinRustagi/eventport/tree/main/apps/playground) includes conversation history, request validation, server-side configuration, and an AI SDK response wrapper that reports stream errors in the chat. Run it with `pnpm dev` after configuring `apps/playground/.env.local`.

## Unsupported events and limits

Unsupported events throw `UnsupportedEventError` by default. Opt into dropping them explicitly when losing that information is acceptable:

```ts
const output = eventport
  .from(responses())
  .to(aiSDK())
  .convert(upstream)
  .onUnsupported((diagnostic) => {
    console.warn(diagnostic.adapter, diagnostic.stage, diagnostic.reason);
    return "drop"; // Return "error" to fail instead.
  });
```

Eventport owns conversion state for one run. Your app owns authentication, persistence, tool execution, approval decisions, and resumption. Translating an approval request does not approve it. Protocol conversion is not guaranteed to be lossless, and translated usage is not authoritative billing data.

For implementation details, see the [architecture](https://github.com/AbhinRustagi/eventport/blob/main/packages/eventport/docs/architecture.md) and [package reference](https://github.com/AbhinRustagi/eventport/blob/main/packages/eventport/README.md).
