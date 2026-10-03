# Bootstrap coverage

This is a working event-conversion bootstrap. It is not full compliance with every API or a claim of lossless round trips. Provider request conversion and complete message documents are not implemented.

| Adapter | Text | Function-call input | Reasoning | Tool results / approvals | State |
| --- | --- | --- | --- | --- | --- |
| Chat Completions | In/out, choice 0 | In/out, indexed parallel calls | Nonstandard reasoning fields rejected | Not representable as completion chunks | No |
| Responses | In/out | In/out | Summary events and encrypted reasoning preserved as opaque input; native output unsupported | Hosted-tool output unsupported | No |
| Anthropic | In/out | In/out | Thinking text and signatures; redacted thinking preserved as opaque input | Server-tool blocks unsupported | No |
| AG-UI | In/out | In/out | Reasoning message events | Results and interrupt outcomes; questions are not approvals | Snapshots / patches |
| Vercel AI SDK UI | In/out | In/out | Reasoning chunks | Results, tool errors, approval requests | Eventport data extensions |
| LangGraph | Input | Input | Text/thinking blocks when explicitly typed | Correlated results, generic interrupt questions | `values` snapshots |

AG-UI and AI SDK carry usage, some metadata and opaque payloads using extension events. This preserves information for applications but does not recreate provider-native semantics when converting back. Eventport extension names are reserved (`eventport.*`, `data-eventport-*`).

## Known limits

- One provider response/run per conversion. Streaming events must be complete, ordered and include their lifecycle starts. Raw bytes/SSE strings and final response snapshots are not accepted.
- Chat Completions only processes choice 0; additional choices trigger the unsupported policy. Audio, refusals, legacy `function_call`, logprobs and nonstandard reasoning deltas are unsupported.
- Responses output is a text/function-call event subset with a synthetic response snapshot. It is suitable for these event consumers, not a complete OpenAI HTTP endpoint implementation. Request configuration fields are not reconstructed. Summary reasoning cannot be relabeled as full reasoning.
- Anthropic thinking replay needs its original signature. Unsigned reasoning cannot become valid provider-authenticated thinking. Redacted/opaque thinking is carried to extensible UI protocols rather than replayed to Anthropic.
- AG-UI compact `*_CHUNK`, reasoning scope events, encrypted values, multimodal/activity events and message snapshots are not implemented. Tool-result error flags have no standard mapping in this bootstrap and trigger a diagnostic.
- AI SDK refers to the SSE UIMessage stream (v1 header, typed against AI SDK 7), not v4 data streams or Core `fullStream`. Source citations, files, provider metadata, message metadata and tool denial/resolution variants are not fully modeled. Unknown event types throw; optional metadata fields outside the supported subset are not guaranteed to survive.
- LangGraph accepts SDK `messages` / `messages-tuple`, `values`, `custom`, `metadata`, and `error` envelopes, or explicitly selected named tuples. Stable message IDs are required. Subgraph namespace and step qualify tool identities; ambiguous reused IDs are rejected. This is not `streamEvents()`, checkpoint serialization, or a LangGraph server implementation. Tool results must have their originating tool inputs in the conversion. Historical `values.messages` are not emitted again as new text.
- Destination IDs and content-block grouping may differ from the source. Repeated runs, message history, reconnect cursors and resume handling remain application concerns.
- No automatic network calls, command delivery, interaction binding store, approval resolution or tool execution.

## Protocol references

- [OpenAI streaming response guide](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Anthropic streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [AG-UI event definitions](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/sdk/js/core/events.mdx)
- [AI SDK UI stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
- [LangGraph streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming)

Upstream declarations are pinned to OpenAI 7.27.0, Anthropic 0.131.0, AG-UI 1.0.1, AI SDK 7.0.127, LangGraph SDK 1.12.0 and LangChain Core 1.2.14. They are development dependencies and their reachable types are bundled at build time. Updating a pin requires rebuilding and checking conversion behavior; a larger union does not automatically add mappings.

Provider endpoints have not been exercised with credentials. Earlier bootstrap checks also exercised AG-UI 0.0.57 schemas. Output now compiles against the pinned upstream declarations, including required metadata and typed finish reasons. Synthetic Responses request settings and token-detail defaults are adapter defaults, not recovered provider facts.
