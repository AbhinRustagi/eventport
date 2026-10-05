import type { EventType } from "@ag-ui/core";
import { usageEvent, readUsage, finishReason } from "../protocol.js";
import type { Adapter } from "../types.js";
import { key, Lifecycle, namedSSE, unsupported } from "../internal.js";

import type {
  ResponseStreamEvent,
  Response,
  ResponseOutputItem,
} from "openai/resources/responses/responses";
export type ResponsesEvent = ResponseStreamEvent;
export type ResponseSnapshot = Response;
export type ResponseItem = ResponseOutputItem;

export function responses(
  options: { model?: string } = {},
): Adapter<ResponsesEvent> {
  return {
    name: "responses",
    key,
    wire: { frame: namedSSE },
    decoder(context) {
      const life = new Lifecycle();
      const calls = new Map<string, string>();
      const closed = new Set<string>();
      return {
        async push(e) {
          switch (e.type) {
            case "response.created":
            case "response.in_progress":
              return life.start(e.response.id);
            case "response.output_item.added": {
              const item = e.item;
              if (item.type === "function_call") {
                if (!item.id)
                  throw new Error(
                    "Responses function call requires an item id.",
                  );
                calls.set(item.id, item.call_id);
                return [
                  ...life.tool(item.call_id, item.name, item.id),
                  ...life.toolDelta(item.call_id, item.arguments),
                ];
              }
              if (item.type === "message" || item.type === "reasoning")
                return life.start();
              return unsupported(context, e);
            }
            case "response.output_text.delta":
              return life.delta(
                `${e.item_id}:${e.content_index}`,
                e.delta,
                "text",
                e.item_id,
              );
            case "response.output_text.done": {
              const id = `${e.item_id}:${e.content_index}`;
              if (closed.has(id)) return [];
              closed.add(id);
              return life.blocks.has(id) ? life.endBlock(id) : [];
            }
            case "response.content_part.added":
              return life.block(
                `${e.item_id}:${e.content_index}`,
                "text",
                e.item_id,
              );
            case "response.content_part.done":
              return [];
            case "response.function_call_arguments.delta": {
              const id = calls.get(e.item_id);
              if (!id)
                throw new Error("Missing Responses function call start.");
              return life.toolDelta(id, e.delta);
            }
            case "response.function_call_arguments.done": {
              const id = calls.get(e.item_id);
              return id && life.tools.has(id) ? life.endTool(id) : [];
            }
            // Summaries are kept opaque; they must not masquerade as full reasoning text.
            case "response.reasoning_summary_part.added":
            case "response.reasoning_summary_part.done":
            case "response.reasoning_summary_text.delta":
            case "response.reasoning_summary_text.done":
              return [
                { type: "RAW" as EventType.RAW, source: "responses", event: e },
              ];
            case "response.output_item.done":
              if (e.item.type === "reasoning" && e.item.encrypted_content)
                return [
                  {
                    type: "RAW" as EventType.RAW,
                    source: "responses",
                    event: e,
                  },
                ];
              return [];
            case "response.completed":
            case "response.incomplete": {
              const u = e.response.usage;
              return [
                ...(u
                  ? [
                      usageEvent({
                        input: u.input_tokens,
                        output: u.output_tokens,
                        total: u.total_tokens,
                        details: u,
                      }),
                    ]
                  : []),
                ...life.end(e.response.incomplete_details?.reason ?? "stop"),
              ];
            }
            case "response.failed":
              life.ended = true;
              return [
                {
                  type: "RUN_ERROR" as EventType.RUN_ERROR,
                  message: e.response.error?.message ?? "Response failed",
                  code: e.response.error?.code,
                },
              ];
            case "error":
              life.ended = true;
              return [
                {
                  type: "RUN_ERROR" as EventType.RUN_ERROR,
                  message: e.message,
                  code: e.code ?? undefined,
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
      const id = `resp_${crypto.randomUUID()}`;
      let sequence = 0;
      const items: ResponseItem[] = [];
      const blocks = new Map<string, { item: ResponseItem; index: number }>();
      let usage: ResponseSnapshot["usage"] = undefined;
      const snapshot = (
        status: ResponseSnapshot["status"],
      ): ResponseSnapshot => ({
        id,
        object: "response",
        access_programs: null,
        output_text: items
          .flatMap((item) =>
            item.type === "message"
              ? item.content.flatMap((part) =>
                  part.type === "output_text" ? [part.text] : [],
                )
              : [],
          )
          .join(""),
        instructions: null,
        metadata: null,
        parallel_tool_calls: true,
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
        created_at: Math.floor(Date.now() / 1000),
        status,
        model: options.model ?? "unknown",
        output: structuredClone(items),
        usage,
        error: null,
        incomplete_details: null,
      });
      type Unsequenced<E> = E extends unknown
        ? Omit<E, "sequence_number">
        : never;
      const emit = (events: Unsequenced<ResponsesEvent>[]): ResponsesEvent[] =>
        events.map((event) => ({ ...event, sequence_number: sequence++ }));
      return {
        async push(e) {
          const tokenUsage = readUsage(e);
          if (tokenUsage) {
            usage = {
              input_tokens: tokenUsage.input ?? 0,
              input_tokens_details: {
                cached_tokens: 0,
                cache_write_tokens: 0,
              },
              output_tokens_details: { reasoning_tokens: 0 },
              output_tokens: tokenUsage.output ?? 0,
              total_tokens:
                tokenUsage.total ??
                (tokenUsage.input ?? 0) + (tokenUsage.output ?? 0),
            };
            if (e.type !== "RUN_FINISHED") return [];
          }
          if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt")
            await context.unsupported(
              e,
              "Target cannot represent interrupted runs.",
            );
          switch (e.type) {
            case "RUN_STARTED":
              return emit([
                { type: "response.created", response: snapshot("in_progress") },
                {
                  type: "response.in_progress",
                  response: snapshot("in_progress"),
                },
              ]);
            case "TEXT_MESSAGE_START":
            case "REASONING_MESSAGE_START": {
              if (e.type === "REASONING_MESSAGE_START") {
                await context.unsupported(
                  e,
                  "Responses reasoning summaries cannot represent arbitrary reasoning text.",
                );
                return [];
              }
              const item: ResponseItem = {
                type: "message",
                id: `msg_${items.length}`,
                role: "assistant",
                status: "in_progress",
                content: [],
              };
              const index = items.length;
              items.push(item);
              blocks.set(e.messageId, { item, index });
              const events: Unsequenced<ResponsesEvent>[] = [
                {
                  type: "response.output_item.added",
                  output_index: index,
                  item: structuredClone(item),
                },
              ];
              const part = {
                type: "output_text" as const,
                text: "",
                annotations: [],
              };
              item.content.push(part);
              events.push({
                type: "response.content_part.added",
                item_id: item.id,
                output_index: index,
                content_index: 0,
                part: structuredClone(part),
              });
              return emit(events);
            }
            case "TEXT_MESSAGE_CONTENT":
            case "REASONING_MESSAGE_CONTENT": {
              const b = blocks.get(e.messageId);
              if (!b || b.item.type !== "message") return [];
              const part = b.item.content[0];
              if (!part || part.type !== "output_text")
                throw new Error("Missing output text part.");
              part.text += e.delta;
              return emit([
                {
                  type: "response.output_text.delta",
                  item_id: b.item.id!,
                  output_index: b.index,
                  content_index: 0,
                  delta: e.delta,
                  logprobs: [],
                },
              ]);
            }
            case "TEXT_MESSAGE_END":
            case "REASONING_MESSAGE_END": {
              const b = blocks.get(e.messageId);
              if (!b || b.item.type !== "message") return [];
              const part = b.item.content[0];
              if (!part || part.type !== "output_text")
                throw new Error("Missing output text part.");
              b.item.status = "completed";
              return emit([
                {
                  type: "response.output_text.done",
                  item_id: b.item.id!,
                  output_index: b.index,
                  content_index: 0,
                  text: part.text,
                  logprobs: [],
                },
                {
                  type: "response.content_part.done",
                  item_id: b.item.id!,
                  output_index: b.index,
                  content_index: 0,
                  part: { ...part, annotations: part.annotations ?? [] },
                },
                {
                  type: "response.output_item.done",
                  output_index: b.index,
                  item: structuredClone(b.item),
                },
              ]);
            }
            case "TOOL_CALL_START": {
              const item: ResponseItem = {
                type: "function_call",
                id: `fc_${items.length}`,
                call_id: e.toolCallId,
                name: e.toolCallName,
                arguments: "",
                status: "in_progress",
              };
              const index = items.length;
              items.push(item);
              blocks.set(e.toolCallId, { item, index });
              return emit([
                {
                  type: "response.output_item.added",
                  output_index: index,
                  item: structuredClone(item),
                },
              ]);
            }
            case "TOOL_CALL_ARGS": {
              const b = blocks.get(e.toolCallId);
              if (!b || b.item.type !== "function_call")
                throw new Error("Tool delta without start.");
              b.item.arguments += e.delta;
              return emit([
                {
                  type: "response.function_call_arguments.delta",
                  item_id: b.item.id!,
                  output_index: b.index,
                  delta: e.delta,
                },
              ]);
            }
            case "TOOL_CALL_END": {
              const b = blocks.get(e.toolCallId);
              if (!b || b.item.type !== "function_call")
                throw new Error("Tool end without start.");
              b.item.status = "completed";
              return emit([
                {
                  type: "response.function_call_arguments.done",
                  item_id: b.item.id!,
                  output_index: b.index,
                  arguments: b.item.arguments,
                },
                {
                  type: "response.output_item.done",
                  output_index: b.index,
                  item: structuredClone(b.item),
                },
              ]);
            }
            case "RUN_FINISHED": {
              const incomplete = [
                "length",
                "max_tokens",
                "max_output_tokens",
              ].includes(finishReason(e));
              const response = snapshot(
                incomplete ? "incomplete" : "completed",
              );
              if (incomplete)
                response.incomplete_details = { reason: "max_output_tokens" };
              return emit([
                {
                  type: incomplete
                    ? "response.incomplete"
                    : "response.completed",
                  response,
                },
              ]);
            }
            case "RUN_ERROR":
              return emit([
                {
                  type: "response.failed",
                  response: {
                    ...snapshot("failed"),
                    error: {
                      code: "server_error",
                      message: e.message,
                    },
                  },
                },
              ]);
            default:
              await context.unsupported(
                e,
                `Responses output cannot represent ${e.type === "CUSTOM" ? e.name : e.type}.`,
              );
              return [];
          }
        },
        finish: () => [],
      };
    },
  };
}
