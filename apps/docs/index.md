# Eventport

Typed AI protocol conversion for the server and browser. Zero runtime dependencies.

```ts
import { eventport } from "eventport";
import { responses } from "eventport/openai";
import { agUI } from "eventport/agui";

const output = eventport
  .from(responses())
  .to(agUI({ threadId, runId }))
  .convert(upstream);
```

## Get started

Install Eventport in your app:

```sh
pnpm add eventport
```

ESM JavaScript with bundled TypeScript types. Import only the adapters you use.

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

## Typed middleware

Use `.middleware()` before `.to()` for source events, or after it for destination events. Keys and payloads are typed automatically.

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

Return an event, an array of events, or `null` to drop it. Async callbacks are supported.

## Overrides

Replace a default conversion with your own destination event.

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

Return an event or array to replace the output, `null` to suppress it, or `eventport.DEFAULT` to keep the default. Keep start/end events consistent.

## Reusable configuration

Configure once and reuse. Chained methods return a new configuration.

```ts
const converter = eventport.from(responses()).to(aiSDK());
const upperCase = converter.middleware({
  "text-delta": (event) => ({ ...event, delta: event.delta.toUpperCase() }),
});

const original = converter.convert(upstream);
const replay = upperCase.convert(storedEvents);
```

Each `.convert()` call returns a new, single-use run.

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

Install `openai` for this example and set `OPENAI_API_KEY` on the server. Pass the same abort signal to both calls.

See the [assistant-ui example](https://github.com/AbhinRustagi/eventport/tree/main/apps/playground) for the complete app.

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

Your app handles provider calls, tool execution, approvals, and persistence. See [adapter coverage](https://github.com/AbhinRustagi/eventport/blob/main/packages/eventport/docs/coverage.md) for supported events and limits.

For implementation details, see the [architecture](https://github.com/AbhinRustagi/eventport/blob/main/packages/eventport/docs/architecture.md) and [package reference](https://github.com/AbhinRustagi/eventport/blob/main/packages/eventport/README.md).
