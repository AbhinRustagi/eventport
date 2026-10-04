# Bootstrap verification

Verified locally on Node.js 22 and 26 with TypeScript 5.9.3.

- TypeScript strict build and emitted declaration compilation.
- Positive and negative consumer checks: source/destination callback narrowing, wrong event keys, void middleware, required AG-UI configuration, LangGraph rejected as a destination, broader native event unions accepted.
- Thirty source/target combinations (six inputs × five outputs) for text and function-call input preservation, stored arrays versus async generators, and SSE framing.
- Async source middleware, unknown-event errors, missing terminal events, cancellation of readable sources and pending reads, and single-use enforcement.
- Signed Anthropic reasoning round trip, native AG-UI schema validation, approval request round trip through AG-UI interrupt outcomes, and explicit rejection of approvals by Chat Completions.
- Interleaved parallel tool arguments with distinct IDs and independently reconstructed JSON.
- Package dry run and installation from the packed archive into a separate temporary consumer, including a conversion through public subpath exports.
- Browser verification of the local workbench with stored events, live replay and uppercase middleware.

The original bootstrap checks used temporary scripts. A committed regression suite now lives in `test/` and runs with `pnpm test` from the workspace root. It includes the conversion matrix, middleware and lifecycle cases, tuple middleware, typed consumers and an offline package installation. It does not prove complete protocol compliance or replace live-provider integration checks.

The upstream-type migration additionally checks bundled declarations with `skipLibCheck` disabled, verifies that no external runtime or type imports survive, and installs the tarball in an isolated consumer without the SDKs. License notices are generated from the packages contributing declarations.

Workspace migration: verified a clean `pnpm install --frozen-lockfile`, root check/build/example scripts, library packing, all 30 conversion pairs and playground asset/API requests.
