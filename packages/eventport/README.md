# Eventport

Typed, composable adapters for AI event streams. Independent project. MIT licensed.

```ts
import { eventport } from "eventport";
import { responses } from "eventport/openai";
import { agUI } from "eventport/agui";

return eventport
  .convert(upstream)
  .from(responses())
  .to(agUI({ threadId, runId }))
  .toResponse();
```

**Bootstrap release:** six source adapters, five destination adapters, zero runtime dependencies. This is a supported subset of each protocol, not a lossless universal converter or a replacement for an agent runtime. See [coverage](docs/coverage.md).

## Run locally

Requires Node.js 22+ and pnpm 10. Run these commands from the workspace root.

```sh
pnpm install
pnpm dev
```

Open <http://127.0.0.1:4321>. The workbench uses local fixtures, lets you edit native events, and compares stored-array conversion with simulated live streaming. No keys, account, external API calls or telemetry. Stop with Ctrl-C; set `PORT` to change the port.

```sh
pnpm check
pnpm test
pnpm build
pnpm example
```

The package has not been published. Use this checkout or `pnpm pack:lib` to install it locally. The root import does not register adapters: import only the subpaths you use. ESM JavaScript and declarations ship together; no provider SDK is installed at runtime.

## Adapters

| Import | Factory | Input | Output |
| --- | --- | --- | --- |
| `eventport/openai` | `chatCompletions()` | Chat Completions chunks, choice 0 | Chat Completions chunks |
| `eventport/openai` | `responses()` | Responses events | Responses-style text/function-call event subset |
| `eventport/anthropic` | `anthropic()` | Messages streaming events | Messages streaming events |
| `eventport/agui` | `agUI({ threadId, runId })` | AG-UI events | AG-UI events |
| `eventport/vercel` | `aiSDK()` | UIMessage stream chunks | UIMessage stream chunks |
| `eventport/langgraph` | `langGraph()` | SDK `{ event, data }` envelopes | — |

`langGraph({ input: "tuples" })` accepts named stream tuples (`[mode, data]`) from a graph using multiple stream modes. `updates`, `streamEvents()` callbacks, protocol-v2 channels and subgraph triple-tuples are not implemented. See the coverage document before connecting a graph.

`aiSDK()` means the **UI message stream**, not AI SDK Core's `fullStream`. `anthropic()` means the Messages API, not Claude Agent SDK.

## Live or stored: same pipeline

`convert` accepts `Iterable`, `AsyncIterable`, or `ReadableStream` of decoded native events. Arrays read from a database work directly:

```ts
const output = await eventport
  .convert(storedEvents)
  .from(responses())
  .to(agUI({ threadId, runId }))
  .collect();
```

Store events in their original order. These are **recorded events**, not completed message objects. Completed conversation/message document conversion, raw SSE byte parsing, command translation and durable bindings are future work. Eventport does not infer missing historical chunks from a final response.

Nothing is consumed until iteration, `.collect()`, or reading the body returned by `.toResponse()`. Every conversion creates fresh adapter state. A conversion is single-use; construct another pipeline to replay an array.

```ts
for await (const event of outputStream) {
  // Inferred destination event union.
}

const readable = outputStream.toReadableStream();
```

## Typed middleware

Keys and callback payloads follow the adapter. Middleware operates on native source events before decoding, or native destination events after encoding.

```ts
const stream = eventport
  .convert(upstream)
  .from(responses(), {
    middleware: {
      "response.output_text.delta": async event => ({
        ...event,
        delta: event.delta.toUpperCase(),
      }),
    },
    observe: event => console.debug("source", event.type),
  })
  .to(agUI({ threadId, runId }), {
    observe: event => console.debug("destination", event.type),
  });
```

Return an event to keep/replace it, an array to expand it, or `null` to drop it. Returning `undefined` is rejected by TypeScript and at runtime. Callbacks and observers are awaited in order. Observer return values do not affect output; exceptions terminate conversion. Source observation sees events after source middleware; destination observation sees events after destination middleware.

Cross-chunk operations need state. A replacement on `"sec"` and `"ret"` cannot find `"secret"` independently. Do not drop lifecycle starts while keeping their deltas. Canonical lifecycle checks detect malformed sequences; arbitrary destination middleware remains responsible for preserving its protocol.

Adapter types come directly from the upstream packages, installed only as pinned development dependencies. The build bundles their reachable declarations into Eventport, including third-party license notices. Consumers need neither the SDKs nor their types installed; all SDK imports in our source are type-only, and build checks reject external imports and compile declarations without ambient Node types. Unrelated AI SDK runtime globals are omitted from the declaration bundle.

Middleware keys cover the upstream event unions, including events that do not yet have a conversion mapping. Unsupported variants are diagnosed at runtime. LangGraph's omitted chunk fields are derived from LangChain's `ToolCallChunk`; the `messages-tuple` envelope alias and Anthropic's transport `ping` are explicit compatibility additions. This does not replace application input validation.

## Unsupported events

The default is to throw `UnsupportedEventError`. Explicitly allow dropping when appropriate:

```ts
const stream = eventport.convert(upstream)
  .from(responses())
  .to(chatCompletions())
  .onUnsupported(diagnostic => {
    console.warn(diagnostic.adapter, diagnostic.stage, diagnostic.reason);
    return "drop"; // Or "error". A decision is required.
  });
```

AG-UI and AI SDK can carry some unmapped data using `RAW` / custom data events. Preserving an opaque payload is not interpreting it or making it usable by another provider. Usage details and signed-reasoning metadata use documented Eventport extensions on UI destinations. These extensions are not currently decoded back into native provider metadata.

## Server integration and cancellation

```ts
const stream = eventport
  .convert(upstream, { signal: request.signal })
  .from(responses())
  .to(aiSDK());

return stream.toResponse({ headers: { "X-Request-Id": requestId } });
```

Pass the **same abort signal into your provider SDK call**. Eventport cancels a supplied `ReadableStream` reader and closes iterable sources; it cannot stop a provider's hidden network request without the SDK's cooperation. Backpressure controls event consumption. In-flight application callbacks may finish after cancellation.

SSE framing is selected by the destination, including the AI SDK protocol header and the Chat Completions/AI SDK `[DONE]` marker. Conversion failures error the response body; after headers are sent they cannot change the HTTP status. `apps/playground/app/api/chat/route.ts` demonstrates live provider streams converted to the AI SDK wire protocol for assistant-ui.

Provider encoders synthesize IDs and use `model: "unknown"` unless configured with `responses({ model })`, `anthropic({ model })`, or `chatCompletions({ model })`. They do not claim that the destination provider generated the content. Missing usage fields are currently represented as zero when a destination requires them; do not use translated usage as authoritative billing data.

## Scope and memory

The package owns conversion only. Your app owns authentication, provider calls, tool execution, persistence, approval delivery and resumption. Converting an approval event never grants approval.

Text is streamed incrementally. Active tool arguments are buffered for JSON validation; the Responses encoder also retains output to construct its final response snapshot. `.collect()` retains all output by definition. There is no global event bus, hidden database, or full event ledger.

## Development

- [Architecture](docs/architecture.md)
- [Coverage and protocol references](docs/coverage.md)
- [Bootstrap verification](docs/verification.md)

MIT © 2026 Eventport contributors.

## Tests

Run `pnpm test` from the workspace root. The suite uses Node's built-in test runner with no additional test framework dependency. It covers all 30 source/destination combinations across stored arrays, async iterables, readable streams and SSE; middleware, cancellation, malformed lifecycles, reasoning, approvals and parallel tool calls; TypeScript inference and rejected usage; and installation of the packed library in a temporary consumer without SDK dependencies.

Fixtures are local, minimal native payloads, not recorded live-provider sessions. Tests make no provider calls. The package-consumer check uses pnpm's offline mode and removes its temporary directory when done. `pnpm --filter eventport test:types` runs only consumer typing checks against the current build.
