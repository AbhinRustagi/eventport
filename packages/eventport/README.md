# Eventport

[![Core minified size](https://img.shields.io/bundlephobia/min/eventport?label=core%20minified)](https://bundlephobia.com/package/eventport)
[![Core gzip size](https://img.shields.io/bundlephobia/minzip/eventport?label=core%20gzip)](https://bundlephobia.com/package/eventport)
[![npm unpacked size](https://img.shields.io/npm/unpacked-size/eventport)](https://www.npmjs.com/package/eventport)

Typed, composable adapters for AI event streams. Independent project. MIT licensed.

```ts
import { eventport } from "eventport";
import { responses } from "eventport/openai";
import { agUI } from "eventport/agui";

return eventport
  .from(responses())
  .to(agUI({ threadId, runId }))
  .convert(upstream)
  .toResponse();
```

Six source adapters, five destination adapters, zero runtime dependencies. See [adapter coverage](docs/coverage.md).

## Installation

```sh
pnpm add eventport
```

ESM JavaScript with bundled TypeScript types. Import only the adapters you use.

## Run the examples locally

Requires Node.js 22+ and pnpm 10. Run these commands from the workspace root.

```sh
pnpm install
pnpm dev
```

Open <http://127.0.0.1:4321> for the assistant-ui example. Configure its server-side API key in `apps/playground/.env.local`; see the [app setup](../../apps/playground/README.md). Run `pnpm docs:dev` for the documentation at <http://127.0.0.1:4322>.

```sh
pnpm check
pnpm test
pnpm build
pnpm example
```

## Adapters

Adapters translate through AG-UI internally. Provider details use namespaced `CUSTOM` events and metadata; unsupported mappings follow `.onUnsupported()`.

| Import                | Factory                     | Input                             | Output                                          |
| --------------------- | --------------------------- | --------------------------------- | ----------------------------------------------- |
| `eventport/openai`    | `chatCompletions()`         | Chat Completions chunks, choice 0 | Chat Completions chunks                         |
| `eventport/openai`    | `responses()`               | Responses events                  | Responses-style text/function-call event subset |
| `eventport/anthropic` | `anthropic()`               | Messages streaming events         | Messages streaming events                       |
| `eventport/agui`      | `agUI({ threadId, runId })` | AG-UI events                      | AG-UI events                                    |
| `eventport/vercel`    | `aiSDK()`                   | UIMessage stream chunks           | UIMessage stream chunks                         |
| `eventport/langgraph` | `langGraph()`               | SDK `{ event, data }` envelopes   | —                                               |

For named LangGraph tuples, use `langGraph({ input: "tuples" })`.

`aiSDK()` means the **UI message stream**, not AI SDK Core's `fullStream`. `anthropic()` means the Messages API, not Claude Agent SDK.

## Live or stored: same pipeline

`convert` accepts `Iterable`, `AsyncIterable`, or `ReadableStream` of decoded native events. Arrays read from a database work directly:

```ts
const output = await eventport
  .from(responses())
  .to(agUI({ threadId, runId }))
  .convert(storedEvents)
  .collect();
```

Pass ordered, decoded events—not raw SSE bytes or completed messages.

```ts
for await (const event of outputStream) {
  // Inferred destination event union.
}

const readable = outputStream.toReadableStream();
```

## Typed middleware

Use `.middleware()` before `.to()` for source events, or after it for destination events. Keys and payloads are typed automatically.

```ts
const stream = eventport
  .from(responses())
  .middleware({
    "response.output_text.delta": async (event) => ({
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

## Unsupported events

The default is to throw `UnsupportedEventError`. Explicitly allow dropping when appropriate:

```ts
const stream = eventport
  .from(responses())
  .to(chatCompletions())
  .convert(upstream)
  .onUnsupported((diagnostic) => {
    console.warn(diagnostic.adapter, diagnostic.stage, diagnostic.reason);
    return "drop"; // Or "error". A decision is required.
  });
```

## Server integration and cancellation

```ts
const stream = eventport
  .from(responses())
  .to(aiSDK())
  .convert(upstream, { signal: request.signal });

return stream.toResponse({ headers: { "X-Request-Id": requestId } });
```

Pass the same abort signal to Eventport and your provider SDK.

See the [assistant-ui example](https://github.com/AbhinRustagi/eventport/tree/main/apps/playground) for a complete server integration.

## Scope and memory

Your app handles provider calls, tool execution, approvals, and persistence. See [adapter coverage](https://github.com/AbhinRustagi/eventport/blob/main/packages/eventport/docs/coverage.md) for supported events and limits.

## Development

- [Architecture](docs/architecture.md)
- [Coverage and protocol references](docs/coverage.md)
- [Bootstrap verification](docs/verification.md)

MIT © 2026 AbhinRustagi.

## Tests

Run `pnpm test` from the workspace root. Tests run without API keys.

## Custom adapters

Decoders return `AGUIEvent` from `eventport`; encoders receive the same type. `CanonicalEvent` is an alias for this bundled AG-UI union. Usage and streaming interaction requests use `eventport.usage` and `eventport.interaction.requested` custom events. Reasoning signatures use `eventport.block-metadata`; finish reasons and structured tool results live in `metadata.eventport`.
