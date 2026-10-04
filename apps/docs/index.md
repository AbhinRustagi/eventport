# Eventport

Typed adapters for converting AI events between protocols, on the server or in the browser. Import the adapters you use; the library has zero runtime dependencies and bundles the upstream event types.

```ts
import { eventport } from "eventport";
import { responses } from "eventport/openai";
import { agUI } from "eventport/agui";

const output = eventport
  .convert(upstream)
  .from(responses())
  .to(agUI({ threadId, runId }));
```

Your app calls the provider. Eventport converts its decoded events. It does not make model requests or execute tools.

## Get started

Eventport is not yet published to npm. To try the current package, build a tarball from the repository with Node.js 22+ and pnpm 10:

```sh
git clone https://github.com/AbhinRustagi/eventport.git
cd eventport
pnpm install
pnpm pack:lib
```

Install the generated tarball in your app:

```sh
pnpm add /path/to/eventport/packages/eventport/eventport-0.1.0.tgz
```

Inside this workspace, use `"eventport": "workspace:*"`. The published format is ESM; adapter SDKs are not required unless your app uses them to call a provider.

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
  .convert(events)
  .from(aiSDK())
  .to(agUI({ threadId: "thread-1", runId: "run-1" }))
  .collect();
```

## Adapters

| Import | Factory | Source | Destination |
| --- | --- | --- | --- |
| `eventport/openai` | `chatCompletions()` | Chat Completions chunks | Yes |
| `eventport/openai` | `responses()` | Responses events | Yes |
| `eventport/anthropic` | `anthropic()` | Anthropic Messages events | Yes |
| `eventport/agui` | `agUI({ threadId, runId })` | AG-UI events | Yes |
| `eventport/vercel` | `aiSDK()` | AI SDK UI message chunks | Yes |
| `eventport/langgraph` | `langGraph()` | LangGraph SDK event envelopes | No |

`aiSDK()` accepts the **UI message stream**, not Core `fullStream`. `anthropic()` supports the Messages API, not Claude Agent SDK. For named LangGraph tuples, use `langGraph({ input: "tuples" })`.

Adapters support a subset of each protocol. See the [coverage matrix](https://github.com/AbhinRustagi/eventport/blob/main/packages/eventport/docs/coverage.md) for reasoning, tool calls, approvals, state, and unsupported variants.

## Live and stored events

The same pipeline accepts arrays, synchronous or asynchronous iterables, and `ReadableStream` objects. Supply decoded native events in order, with their lifecycle boundaries. Raw SSE bytes and completed message documents are not accepted.

Choose how to consume the conversion:

| Method | Result |
| --- | --- |
| `for await (const event of output)` | Incremental destination events |
| `await output.collect()` | An array of destination events |
| `output.toReadableStream()` | A stream of destination event objects |
| `output.toResponse()` | An SSE `Response` with destination headers and framing |

Conversion is lazy and single-use. Create another pipeline to replay recorded events. `.collect()` stores the whole output in memory.

## Typed middleware

Middleware keys and event payloads follow the selected adapter. Source hooks run before decoding; destination hooks run after encoding.

```ts
const output = eventport
  .convert(upstream)
  .from(responses(), {
    middleware: {
      "response.output_text.delta": event => ({
        ...event,
        delta: event.delta.toUpperCase(),
      }),
    },
    observe: event => console.debug(event.type),
  })
  .to(agUI({ threadId, runId }));
```

Return an event, an array of events, or `null` to drop one. Returning `undefined` is an error. Hooks are awaited in order. Observers see events after middleware and cannot replace them.

Keep lifecycle events consistent: dropping a start while retaining its deltas makes the stream invalid. Operations that match text across chunks need application-managed state.

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
    .convert(upstream, { signal: request.signal })
    .from(responses())
    .to(aiSDK())
    .toResponse();
}
```

Install `openai` in the server app for this example. Pass the same abort signal to the provider SDK and Eventport so cancellation stops both the network request and conversion.

The [assistant-ui example app](https://github.com/AbhinRustagi/eventport/tree/main/apps/playground) includes conversation history, request validation, server-side configuration, and an AI SDK response wrapper that reports stream errors in the chat. Run it with `pnpm dev` after configuring `apps/playground/.env.local`.

## Unsupported events and limits

Unsupported events throw `UnsupportedEventError` by default. Opt into dropping them explicitly when losing that information is acceptable:

```ts
const output = eventport
  .convert(upstream)
  .from(responses())
  .to(aiSDK())
  .onUnsupported(diagnostic => {
    console.warn(diagnostic.adapter, diagnostic.stage, diagnostic.reason);
    return "drop"; // Return "error" to fail instead.
  });
```

Eventport owns conversion state for one run. Your app owns authentication, persistence, tool execution, approval decisions, and resumption. Translating an approval request does not approve it. Protocol conversion is not guaranteed to be lossless, and translated usage is not authoritative billing data.

For implementation details, see the [architecture](https://github.com/AbhinRustagi/eventport/blob/main/packages/eventport/docs/architecture.md) and [package reference](https://github.com/AbhinRustagi/eventport/blob/main/packages/eventport/README.md).
