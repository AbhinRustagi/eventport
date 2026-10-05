import type { EventType } from "@ag-ui/core";
import {
  usageEvent,
  metadataEvent,
  readUsage,
  readMetadata,
  finishReason,
} from "../protocol.js";
import type { Adapter } from "../types.js";
import { key, Lifecycle, namedSSE, unsupported } from "../internal.js";

import type {
  RawMessageStreamEvent,
  ContentBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { ErrorResponse } from "@anthropic-ai/sdk/resources/shared";
export type AnthropicBlock = ContentBlock;
/** Ping is a transport keepalive, omitted from the SDK stream union. */
export type AnthropicEvent =
  RawMessageStreamEvent | ErrorResponse | { type: "ping" };

export function anthropic(
  options: { model?: string } = {},
): Adapter<AnthropicEvent> {
  return {
    name: "anthropic",
    key,
    wire: { frame: namedSSE },
    decoder(context) {
      const life = new Lifecycle();
      const indexes = new Map<
        number,
        { id: string; kind: "text" | "reasoning" | "tool" | "opaque" }
      >();
      let messageId = life.id,
        input = 0,
        output = 0,
        reason = "end_turn";
      return {
        async push(e) {
          switch (e.type) {
            case "message_start":
              messageId = e.message.id;
              input = e.message.usage.input_tokens;
              output = e.message.usage.output_tokens;
              return life.start(messageId);
            case "content_block_start": {
              if (indexes.has(e.index))
                throw new Error("Duplicate Anthropic content block index.");
              const b = e.content_block,
                id = `${messageId}:${e.index}`;
              if (b.type === "text") {
                indexes.set(e.index, { id, kind: "text" });
                return life.delta(id, b.text, "text", messageId);
              }
              if (b.type === "thinking") {
                indexes.set(e.index, { id, kind: "reasoning" });
                const events = life.delta(
                  id,
                  b.thinking,
                  "reasoning",
                  messageId,
                );
                if (b.signature)
                  events.push(
                    metadataEvent({
                      id: id,
                      namespace: "anthropic",
                      value: { signature: b.signature },
                    }),
                  );
                return events;
              }
              if (b.type === "tool_use") {
                indexes.set(e.index, { id: b.id, kind: "tool" });
                const events = life.tool(b.id, b.name, messageId);
                if (
                  b.input &&
                  typeof b.input === "object" &&
                  Object.keys(b.input).length
                )
                  events.push(...life.toolDelta(b.id, JSON.stringify(b.input)));
                return events;
              }
              indexes.set(e.index, { id, kind: "opaque" });
              return [
                { type: "RAW" as EventType.RAW, source: "anthropic", event: e },
              ];
            }
            case "content_block_delta": {
              const b = indexes.get(e.index);
              if (!b) throw new Error("Anthropic delta without block start.");
              if (b.kind === "opaque")
                return [
                  {
                    type: "RAW" as EventType.RAW,
                    source: "anthropic",
                    event: e,
                  },
                ];
              const d = e.delta;
              if (d.type === "text_delta" && b.kind === "text")
                return life.delta(b.id, d.text, "text", messageId);
              if (d.type === "thinking_delta" && b.kind === "reasoning")
                return life.delta(b.id, d.thinking, "reasoning", messageId);
              if (d.type === "signature_delta" && b.kind === "reasoning")
                return [
                  metadataEvent({
                    id: b.id,
                    namespace: "anthropic",
                    value: { signature: d.signature },
                  }),
                ];
              if (d.type === "input_json_delta" && b.kind === "tool")
                return life.toolDelta(b.id, d.partial_json);
              return unsupported(
                context,
                e,
                "Unsupported or mismatched Anthropic delta.",
              );
            }
            case "content_block_stop": {
              const b = indexes.get(e.index);
              if (!b) throw new Error("Anthropic block stop without start.");
              indexes.delete(e.index);
              return b.kind === "opaque"
                ? [
                    {
                      type: "RAW" as EventType.RAW,
                      source: "anthropic",
                      event: e,
                    },
                  ]
                : b.kind === "tool"
                  ? life.endTool(b.id)
                  : life.endBlock(b.id);
            }
            case "message_delta":
              input = e.usage.input_tokens ?? input;
              output = e.usage.output_tokens;
              reason = e.delta.stop_reason ?? reason;
              return [];
            case "message_stop":
              return [
                usageEvent({
                  input: input,
                  output: output,
                  total: input + output,
                }),
                ...life.end(reason),
              ];
            case "ping":
              return [];
            case "error":
              life.ended = true;
              return [
                {
                  type: "RUN_ERROR" as EventType.RUN_ERROR,
                  message: e.error.message,
                  code: e.error.type,
                },
              ];
            default:
              return unsupported(context, e);
          }
        },
        finish: () => life.finish(),
      };
    },
    encoder(context) {
      let index = 0,
        output = 0,
        input = 0,
        hasTools = false;
      const blocks = new Map<
        string,
        {
          index: number;
          kind: "text" | "reasoning" | "tool";
          signature: boolean;
        }
      >();
      return {
        async push(e): Promise<AnthropicEvent[]> {
          const tokenUsage = readUsage(e);
          if (tokenUsage) {
            input = tokenUsage.input ?? input;
            output = tokenUsage.output ?? output;
            if (e.type !== "RUN_FINISHED") return [];
          }
          const metadata = readMetadata(e);
          if (metadata) {
            const b = blocks.get(metadata.id);
            if (
              b &&
              b.kind === "reasoning" &&
              metadata.namespace === "anthropic" &&
              typeof metadata.value.signature === "string"
            ) {
              b.signature = true;
              return [
                {
                  type: "content_block_delta",
                  index: b.index,
                  delta: {
                    type: "signature_delta",
                    signature: metadata.value.signature,
                  },
                },
              ];
            }
            await context.unsupported(
              e,
              "Cannot encode this block metadata in Anthropic.",
            );
            return [];
          }
          if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt")
            await context.unsupported(
              e,
              "Target cannot represent interrupted runs.",
            );
          switch (e.type) {
            case "RUN_STARTED":
              return [
                {
                  type: "message_start",
                  message: {
                    id: e.runId,
                    type: "message",
                    role: "assistant",
                    model: options.model ?? "unknown",
                    content: [],
                    container: null,
                    diagnostics: null,
                    stop_details: null,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: {
                      input_tokens: 0,
                      output_tokens: 0,
                      cache_creation_input_tokens: null,
                      cache_read_input_tokens: null,
                      cache_creation: null,
                      inference_geo: null,
                      server_tool_use: null,
                      service_tier: null,
                      output_tokens_details: null,
                    },
                  },
                },
              ];
            case "TEXT_MESSAGE_START":
            case "REASONING_MESSAGE_START": {
              const i = index++;
              blocks.set(e.messageId, {
                index: i,
                kind: e.type === "TEXT_MESSAGE_START" ? "text" : "reasoning",
                signature: false,
              });
              return [
                {
                  type: "content_block_start",
                  index: i,
                  content_block:
                    e.type === "TEXT_MESSAGE_START"
                      ? { type: "text", text: "", citations: null }
                      : { type: "thinking", thinking: "", signature: "" },
                },
              ];
            }
            case "TOOL_CALL_START": {
              const i = index++;
              hasTools = true;
              blocks.set(e.toolCallId, {
                index: i,
                kind: "tool",
                signature: false,
              });
              return [
                {
                  type: "content_block_start",
                  index: i,
                  content_block: {
                    type: "tool_use",
                    id: e.toolCallId,
                    name: e.toolCallName,
                    caller: { type: "direct" },
                    input: {},
                  },
                },
              ];
            }
            case "TEXT_MESSAGE_CONTENT":
            case "REASONING_MESSAGE_CONTENT":
            case "TOOL_CALL_ARGS": {
              const b = blocks.get(
                "toolCallId" in e ? e.toolCallId : e.messageId,
              );
              if (!b) throw new Error("Delta without block start.");
              return [
                {
                  type: "content_block_delta",
                  index: b.index,
                  delta:
                    b.kind === "tool"
                      ? { type: "input_json_delta", partial_json: e.delta }
                      : b.kind === "text"
                        ? { type: "text_delta", text: e.delta }
                        : { type: "thinking_delta", thinking: e.delta },
                },
              ];
            }
            case "TEXT_MESSAGE_END":
            case "REASONING_MESSAGE_END":
            case "TOOL_CALL_END": {
              const b = blocks.get(
                "toolCallId" in e ? e.toolCallId : e.messageId,
              );
              if (!b) throw new Error("Block end without start.");
              if (b.kind === "reasoning" && !b.signature)
                await context.unsupported(
                  e,
                  "Anthropic thinking requires a native signature; unsigned reasoning is not replayable to Anthropic.",
                );
              blocks.delete("toolCallId" in e ? e.toolCallId : e.messageId);
              return [{ type: "content_block_stop", index: b.index }];
            }
            case "RUN_FINISHED":
              return [
                {
                  type: "message_delta",
                  delta: {
                    stop_reason: [
                      "length",
                      "max_tokens",
                      "max_output_tokens",
                    ].includes(finishReason(e))
                      ? "max_tokens"
                      : hasTools
                        ? "tool_use"
                        : "end_turn",
                    stop_sequence: null,
                    stop_details: null,
                    container: null,
                  },
                  usage: {
                    input_tokens: input,
                    output_tokens: output,
                    cache_creation_input_tokens: null,
                    cache_read_input_tokens: null,
                    server_tool_use: null,
                    output_tokens_details: null,
                  },
                },
                { type: "message_stop" },
              ];
            case "RUN_ERROR":
              return [
                {
                  type: "error",
                  error: { type: "api_error", message: e.message },
                  request_id: null,
                },
              ];
            default:
              await context.unsupported(
                e,
                `Anthropic cannot represent ${e.type === "CUSTOM" ? e.name : e.type}.`,
              );
              return [];
          }
        },
        finish: () => [],
      };
    },
  };
}
