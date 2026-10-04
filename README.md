# Eventport

A pnpm workspace for the lightweight AI event conversion library and its local playground.

- `packages/eventport` — publishable MIT library; [API and adapter documentation](packages/eventport/README.md).
- `apps/playground` — private Next.js + assistant-ui app with live model streams, using `eventport` through `workspace:*`; [setup and adapter paths](apps/playground/README.md).

Requires Node.js 22+ and pnpm 10.34.3.

```sh
pnpm install
pnpm check
pnpm build
pnpm test
cp apps/playground/.env.example apps/playground/.env.local
# Add your API key to .env.local, then:
pnpm dev
```

Open http://127.0.0.1:4321. Run `pnpm example` for a terminal conversion or `pnpm pack:lib` to pack the library. Only the library is publishable; the workspace root and playground are private.

Provider SDKs remain library development dependencies. Published consumers receive bundled types and zero runtime dependencies.

`pnpm test` builds the library, runs the Node regression suite, checks middleware types, and verifies an offline-installed package consumer. Tests mock provider HTTP responses and need no API keys. The playground itself requires server-side API keys.

GitHub Actions checks pull requests and `main`. Publishing a GitHub release triggers npm publishing after the checks pass; see [release setup and instructions](.github/RELEASING.md).
