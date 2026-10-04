# Eventport

Lightweight, typed conversion between AI protocols. Works on the server and in the browser, with zero runtime dependencies.

```sh
pnpm add eventport
```

```ts
import { eventport } from "eventport";
import { responses } from "eventport/openai";
import { agUI } from "eventport/agui";

const converter = eventport
  .from(responses())
  .to(agUI({ threadId, runId }));

return converter.convert(upstream).toResponse();
```

Use the same API for live streams and stored event arrays. Return an SSE response with `.toResponse()`, collect events with `.collect()`, or iterate with `for await`.

## Adapters

| Import | Adapters |
| --- | --- |
| `eventport/openai` | `chatCompletions()`, `responses()` |
| `eventport/anthropic` | `anthropic()` |
| `eventport/agui` | `agUI({ threadId, runId })` |
| `eventport/vercel` | `aiSDK()` |
| `eventport/langgraph` | `langGraph()` — source only |

`aiSDK()` uses the UI message stream. See [adapter coverage](packages/eventport/docs/coverage.md) for supported events and limits.

## Customize

Modify native events with typed middleware:

```ts
const converter = eventport
  .from(responses())
  .middleware({
    "response.output_text.delta": event => ({
      ...event,
      delta: event.delta.toUpperCase(),
    }),
  })
  .to(agUI({ threadId, runId }));
```

Replace a conversion with an override:

```ts
const custom = converter.overrides({
  "response.output_text.delta": event => ({
    type: "CUSTOM",
    name: "text.fragment",
    value: { text: event.delta },
  }),
});
```

Return `eventport.DEFAULT` to keep the default mapping, or `null` to suppress its output. Keep destination start/end events consistent.

[Documentation](apps/docs/index.md) · [API reference](packages/eventport/README.md) · [Assistant-ui example](apps/playground/README.md)

## Development

Requires Node.js 22+ and pnpm 10.34.3.

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

- `pnpm docs:dev` — docs at http://127.0.0.1:4322.
- `pnpm dev` — chat app at http://127.0.0.1:4321. Configure API keys using [the example setup](apps/playground/README.md).
- `pnpm example` — terminal conversion example.

See [release instructions](.github/RELEASING.md) for npm publishing.

MIT © 2026 AbhinRustagi.
