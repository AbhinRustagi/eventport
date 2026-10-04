# Architecture

`input → source middleware → decoder → canonical validation → encoder → destination middleware → consumer`

The core knows adapter interfaces, not protocol implementations. Every factory creates immutable configuration; decoder/encoder state is allocated on consumption, so adapters can be reused across concurrent conversions. Explicit subpath imports and `sideEffects: false` allow bundlers to exclude unused adapters. The package is dependency-free at runtime; TypeScript is a development dependency.

The canonical union in `src/types.ts` covers run/step boundaries, text and reasoning blocks, block metadata, tool input/result lifecycles, usage, errors, state snapshots/patches, interaction requests, custom events and opaque native payloads. It is intentionally smaller than the exhaustive future catalog discussed during design. Media, citations, artifact updates, authorization flows, request resolutions and complete conversation documents need additional typed representations before they can be claimed as supported.

`Lifecycle` tracks active source content and closes it at protocol-defined boundaries. Provider streams must terminate explicitly; missing terminal events throw. LangGraph iterator completion is its run boundary. Canonical validation verifies block/tool ordering and parses completed tool argument JSON regardless of the destination. It distinguishes tool-input completion from a tool result and checks approval references.

Adapters must not treat reasoning summaries as full reasoning, treat an approval notification as consent, or turn an unsupported interrupt into ordinary completion. Responses summaries and encrypted details remain opaque; UI outputs can carry them without interpreting them. Provider-only targets require an explicit unsupported decision.

Conversions are single-use because upstream iterators may be one-shot. `.collect()` and `.toReadableStream()` consume the same engine. `.toResponse()` adds target-specific serialization, not an agent runtime. The current implementation parses decoded objects only; parsing SSE bytes belongs in a future transport module.

## Future work

1. Completed message/document adapters behind the same fluent interface, with an explicit input/output mode. Do not infer event history from a final response.
2. A canonical command union separate from events. Optional binding records correlate frontend interactions with backend requests across HTTP calls; application storage and authorization remain external.
3. Full protocol inventories with versioned capability descriptors, citations/media/refusals, reasoning representations and richer interactions.
4. Optional bounded trace recording with source/canonical/destination provenance for the workbench. A ledger is not necessary for ordinary conversion.

The public generic types accept native SDK unions while supplying narrow callback types for known variants. This is compatibility at the source seam, not a guarantee that every SDK event can be translated. Unsupported variants are handled by the configured policy.

## Override behavior

Overrides run after source middleware. Destination middleware receives only the selected output. Returning a replacement suppresses unsupported-event diagnostics for that source event, but malformed lifecycle errors still fail. The built-in decoder and encoder continue updating their state. Finalization output is not overridden, and later snapshots reflect the original converted content and IDs. Replacements must preserve a valid destination sequence.
