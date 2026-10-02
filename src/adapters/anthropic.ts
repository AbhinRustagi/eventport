import type { Adapter, CanonicalEvent } from "../types.js";
import { key, Lifecycle, namedSSE, unsupported } from "../internal.js";

export type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };
export type AnthropicEvent =
  | { type: "message_start"; message: { id: string; type: "message"; role: "assistant"; model: string; content: AnthropicBlock[]; stop_reason: string | null; stop_sequence: string | null; usage: { input_tokens: number; output_tokens: number } } }
  | { type: "content_block_start"; index: number; content_block: AnthropicBlock }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: "thinking_delta"; thinking: string } | { type: "signature_delta"; signature: string } | { type: "input_json_delta"; partial_json: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string | null; stop_sequence?: string | null }; usage: { output_tokens: number; input_tokens?: number } }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

export function anthropic(options: { model?: string } = {}): Adapter<AnthropicEvent> {
  return {
    name: "anthropic", key, wire: { frame: namedSSE },
    decoder(context) {
      const life = new Lifecycle();
      const indexes = new Map<number, { id: string; kind: "text" | "reasoning" | "tool" | "opaque" }>();
      let messageId = life.id, input = 0, output = 0, reason = "end_turn";
      return {
        async push(e) {
          switch (e.type) {
            case "message_start": messageId = e.message.id; input = e.message.usage.input_tokens; output = e.message.usage.output_tokens; return life.start(messageId);
            case "content_block_start": {
              if (indexes.has(e.index)) throw new Error("Duplicate Anthropic content block index.");
              const b = e.content_block, id = `${messageId}:${e.index}`;
              if (b.type === "text") { indexes.set(e.index, { id, kind: "text" }); return life.delta(id, b.text, "text", messageId); }
              if (b.type === "thinking") { indexes.set(e.index, { id, kind: "reasoning" }); const events = life.delta(id, b.thinking, "reasoning", messageId); if (b.signature) events.push({ type: "block.metadata", id, namespace: "anthropic", value: { signature: b.signature } }); return events; }
              if (b.type === "tool_use") {
                indexes.set(e.index, { id: b.id, kind: "tool" });
                const events = life.tool(b.id, b.name, messageId);
                if (b.input && typeof b.input === "object" && Object.keys(b.input).length) events.push(...life.toolDelta(b.id, JSON.stringify(b.input)));
                return events;
              }
              indexes.set(e.index, { id, kind: "opaque" }); return [{ type: "opaque", protocol: "anthropic", payload: e }];
            }
            case "content_block_delta": {
              const b = indexes.get(e.index); if (!b) throw new Error("Anthropic delta without block start.");
              if (b.kind === "opaque") return [{ type: "opaque", protocol: "anthropic", payload: e }];
              const d = e.delta;
              if (d.type === "text_delta" && b.kind === "text") return life.delta(b.id, d.text, "text", messageId);
              if (d.type === "thinking_delta" && b.kind === "reasoning") return life.delta(b.id, d.thinking, "reasoning", messageId);
              if (d.type === "signature_delta" && b.kind === "reasoning") return [{ type: "block.metadata", id: b.id, namespace: "anthropic", value: { signature: d.signature } }];
              if (d.type === "input_json_delta" && b.kind === "tool") return life.toolDelta(b.id, d.partial_json);
              return unsupported(context, e, "Unsupported or mismatched Anthropic delta.");
            }
            case "content_block_stop": { const b = indexes.get(e.index); if (!b) throw new Error("Anthropic block stop without start."); indexes.delete(e.index); return b.kind === "opaque" ? [{ type: "opaque", protocol: "anthropic", payload: e }] : b.kind === "tool" ? life.endTool(b.id) : life.endBlock(b.id); }
            case "message_delta": input = e.usage.input_tokens ?? input; output = e.usage.output_tokens; reason = e.delta.stop_reason ?? reason; return [];
            case "message_stop": return [{ type: "usage", input, output, total: input + output }, ...life.end(reason)];
            case "ping": return [];
            case "error": life.ended = true; return [{ type: "error", message: e.error.message, code: e.error.type }];
            default: return unsupported(context, e);
          }
        }, finish: () => life.finish(),
      };
    },
    encoder(context) {
      let index = 0, output = 0, input = 0, hasTools = false;
      const blocks = new Map<string, { index: number; kind: "text" | "reasoning" | "tool"; signature: boolean }>();
      return {
        async push(e) {
          switch (e.type) {
            case "run.start": return [{ type: "message_start", message: { id: e.id, type: "message", role: "assistant", model: options.model ?? "unknown", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }];
            case "block.start": { const i = index++; blocks.set(e.id, { index: i, kind: e.kind, signature: false }); return [{ type: "content_block_start", index: i, content_block: e.kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", signature: "" } }]; }
            case "tool.start": { const i = index++; hasTools = true; blocks.set(e.id, { index: i, kind: "tool", signature: false }); return [{ type: "content_block_start", index: i, content_block: { type: "tool_use", id: e.id, name: e.name, input: {} } }]; }
            case "block.delta": case "tool.delta": {
              const b = blocks.get(e.id); if (!b) throw new Error("Delta without block start.");
              return [{ type: "content_block_delta", index: b.index, delta: b.kind === "tool" ? { type: "input_json_delta", partial_json: e.text } : b.kind === "text" ? { type: "text_delta", text: e.text } : { type: "thinking_delta", thinking: e.text } }];
            }
            case "block.metadata": {
              const b = blocks.get(e.id);
              if (b && b.kind === "reasoning" && e.namespace === "anthropic" && typeof e.value.signature === "string") { b.signature = true; return [{ type: "content_block_delta", index: b.index, delta: { type: "signature_delta", signature: e.value.signature } }]; }
              await context.unsupported(e, "Cannot encode this block metadata in Anthropic."); return [];
            }
            case "block.end": case "tool.end": {
              const b = blocks.get(e.id); if (!b) throw new Error("Block end without start.");
              if (b.kind === "reasoning" && !b.signature) await context.unsupported(e, "Anthropic thinking requires a native signature; unsigned reasoning is not replayable to Anthropic.");
              blocks.delete(e.id); return [{ type: "content_block_stop", index: b.index }];
            }
            case "usage": input = e.input ?? input; output = e.output ?? output; return [];
            case "run.end": return [{ type: "message_delta", delta: { stop_reason: ["length", "max_tokens", "max_output_tokens"].includes(e.reason) ? "max_tokens" : hasTools ? "tool_use" : "end_turn", stop_sequence: null }, usage: { input_tokens: input, output_tokens: output } }, { type: "message_stop" }];
            case "error": return [{ type: "error", error: { type: e.code ?? "api_error", message: e.message } }];
            default: await context.unsupported(e, `Anthropic cannot represent ${e.type}.`); return [];
          }
        }, finish: () => [],
      };
    },
  };
}
