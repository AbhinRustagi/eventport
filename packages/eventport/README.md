# Eventport

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

**Bootstrap release:** six source adapters, five destination adapters, zero runtime dependencies. This is a supported subset of each protocol, not a lossless universal converter or a replacement for an agent runtime. See [coverage](docs/coverage.md).

## Installation

```sh
pnpm add eventport
```

The root import does not register adapters: import only the subpaths you use. ESM JavaScript and declarations ship together; no provider SDK is installed at runtime.

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

| Import                | Factory                     | Input                             | Output                                          |
| --------------------- | --------------------------- | --------------------------------- | ----------------------------------------------- |
| `eventport/openai`    | `chatCompletions()`         | Chat Completions chunks, choice 0 | Chat Completions chunks                         |
| `eventport/openai`    | `responses()`               | Responses events                  | Responses-style text/function-call event subset |
| `eventport/anthropic` | `anthropic()`               | Messages streaming events         | Messages streaming events                       |
| `eventport/agui`      | `agUI({ threadId, runId })` | AG-UI events                      | AG-UI events                                    |
| `eventport/vercel`    | `aiSDK()`                   | UIMessage stream chunks           | UIMessage stream chunks                         |
| `eventport/langgraph` | `langGraph()`               | SDK `{ event, data }` envelopes   | —                                               |

`langGraph({ input: "tuples" })` accepts named stream tuples (`[mode, data]`) from a graph using multiple stream modes. `updates`, `streamEvents()` callbacks, protocol-v2 channels and subgraph triple-tuples are not implemented. See the coverage document before connecting a graph.

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

Return an event to keep/replace it, an array to expand it, or `null` to drop it. Returning `undefined` is rejected by TypeScript and at runtime. Middleware callbacks are awaited in order; exceptions terminate conversion.

Cross-chunk operations need state. A replacement on `"sec"` and `"ret"` cannot find `"secret"` independently. Do not drop lifecycle starts while keeping their deltas. Canonical lifecycle checks detect malformed sequences; arbitrary destination middleware remains responsible for preserving its protocol.

Adapter types come directly from the upstream packages, installed only as pinned development dependencies. The build bundles their reachable declarations into Eventport, including third-party license notices. Consumers need neither the SDKs nor their types installed; all SDK imports in our source are type-only, and build checks reject external imports and compile declarations without ambient Node types. Unrelated AI SDK runtime globals are omitted from the declaration bundle.

Middleware keys cover the upstream event unions, including events that do not yet have a conversion mapping. Unsupported variants are diagnosed at runtime. LangGraph's omitted chunk fields are derived from LangChain's `ToolCallChunk`; the `messages-tuple` envelope alias and Anthropic's transport `ping` are explicit compatibility additions. This does not replace application input validation.

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

AG-UI and AI SDK can carry some unmapped data using `RAW` / custom data events. Preserving an opaque payload is not interpreting it or making it usable by another provider. Usage details and signed-reasoning metadata use documented Eventport extensions on UI destinations. These extensions are not currently decoded back into native provider metadata.

## Server integration and cancellation

```ts
const stream = eventport
  .from(responses())
  .to(aiSDK())
  .convert(upstream, { signal: request.signal });

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
