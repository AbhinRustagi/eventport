# Eventport

A pnpm workspace for the lightweight AI event conversion library and its local playground.

- `packages/eventport` — publishable MIT library; [API and adapter documentation](packages/eventport/README.md).
- `apps/playground` — private local workbench, using `eventport` through `workspace:*`.

Requires Node.js 22+ and pnpm 10.34.3.

```sh
pnpm install
pnpm check
pnpm build
pnpm test
pnpm dev
```

Open http://127.0.0.1:4321. Run `pnpm example` for a terminal conversion or `pnpm pack:lib` to pack the library. Only the library is publishable; the workspace root and playground are private.

Provider SDKs remain library development dependencies. Published consumers receive bundled types and zero runtime dependencies.

`pnpm test` builds the library, runs the Node regression suite, checks middleware types, and verifies an offline-installed package consumer. No API keys or live provider requests are needed.
