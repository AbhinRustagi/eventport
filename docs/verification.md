# Bootstrap verification

Verified locally on Node.js 26 with TypeScript 5.9.3. The advertised baseline is Node.js 22; that baseline has not been separately exercised.

- TypeScript strict build and emitted declaration compilation.
- Positive and negative consumer checks: source/destination callback narrowing, wrong event keys, void middleware, required AG-UI configuration, LangGraph rejected as a destination, broader native event unions accepted.
- Thirty source/target combinations (six inputs × five outputs) for text and function-call input preservation, stored arrays versus async generators, and SSE framing.
- Async source middleware, unknown-event errors, missing terminal events, cancellation of readable sources and pending reads, and single-use enforcement.
- Signed Anthropic reasoning round trip, native AG-UI schema validation, approval request round trip through AG-UI interrupt outcomes, and explicit rejection of approvals by Chat Completions.
- Interleaved parallel tool arguments with distinct IDs and independently reconstructed JSON.
- Browser verification of the local workbench with stored events, live replay and uppercase middleware.

These checks used temporary scripts outside the repository, following the instruction not to add test files. They are not a committed regression suite or proof of complete protocol compliance. A durable fixture-based regression suite should precede a public release.
