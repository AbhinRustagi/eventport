import type { Adapter, CanonicalEvent } from "../types.js";
import { key, Lifecycle, namedSSE, unsupported } from "../internal.js";

export type ResponseItem =
  | {
      type: "message";
      id: string;
      role: "assistant";
      status?: string;
      content: Array<{
        type: "output_text";
        text: string;
        annotations?: unknown[];
      }>;
    }
  | {
      type: "function_call";
      id: string;
      call_id: string;
      name: string;
      arguments: string;
      status?: string;
    }
  | {
      type: "reasoning";
      id: string;
      summary: Array<{ type: "summary_text"; text: string }>;
      encrypted_content?: string | null;
    };
export interface ResponseSnapshot {
  id: string;
  object?: "response";
  status?: string;
  model?: string;
  output?: ResponseItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  } | null;
  error?: { code: string; message: string } | null;
  incomplete_details?: { reason: string } | null;
  [field: string]: unknown;
}
type Indexed = {
  item_id: string;
  output_index: number;
  sequence_number?: number;
};
export type ResponsesEvent =
  | {
      type:
        | "response.created"
        | "response.in_progress"
        | "response.completed"
        | "response.incomplete"
        | "response.failed";
      response: ResponseSnapshot;
      sequence_number?: number;
    }
  | {
      type: "response.output_item.added" | "response.output_item.done";
      output_index: number;
      item: ResponseItem;
      sequence_number?: number;
    }
  | ({
      type: "response.content_part.added" | "response.content_part.done";
      content_index: number;
      part: { type: "output_text"; text: string; annotations: unknown[] };
    } & Indexed)
  | ({
      type: "response.output_text.delta";
      content_index: number;
      delta: string;
    } & Indexed)
  | ({
      type: "response.output_text.done";
      content_index: number;
      text: string;
    } & Indexed)
  | ({
      type: "response.function_call_arguments.delta";
      delta: string;
    } & Indexed)
  | ({
      type: "response.function_call_arguments.done";
      arguments: string;
    } & Indexed)
  | ({
      type:
        | "response.reasoning_summary_part.added"
        | "response.reasoning_summary_part.done";
      summary_index: number;
      part: { type: "summary_text"; text: string };
    } & Indexed)
  | ({
      type: "response.reasoning_summary_text.delta";
      summary_index: number;
      delta: string;
    } & Indexed)
  | ({
      type: "response.reasoning_summary_text.done";
      summary_index: number;
      text: string;
    } & Indexed)
  | { type: "error"; message: string; code?: string; sequence_number?: number };

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
              return [{ type: "opaque", protocol: "responses", payload: e }];
            case "response.output_item.done":
              if (e.item.type === "reasoning" && e.item.encrypted_content)
                return [{ type: "opaque", protocol: "responses", payload: e }];
              return [];
            case "response.completed":
            case "response.incomplete": {
              const u = e.response.usage;
              return [
                ...(u
                  ? [
                      {
                        type: "usage" as const,
                        input: u.input_tokens,
                        output: u.output_tokens,
                        total: u.total_tokens,
                        details: u,
                      },
                    ]
                  : []),
                ...life.end(e.response.incomplete_details?.reason ?? "stop"),
              ];
            }
            case "response.failed":
              life.ended = true;
              return [
                {
                  type: "error",
                  message: e.response.error?.message ?? "Response failed",
                  code: e.response.error?.code,
                },
              ];
            case "error":
              life.ended = true;
              return [{ type: "error", message: e.message, code: e.code }];
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
      let usage: ResponseSnapshot["usage"] = null;
      const snapshot = (status: string): ResponseSnapshot => ({
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status,
        model: options.model ?? "unknown",
        output: structuredClone(items),
        usage,
        error: null,
        incomplete_details: null,
      });
      const emit = (events: ResponsesEvent[]) =>
        events.map((event) => ({ ...event, sequence_number: sequence++ }));
      return {
        async push(e) {
          switch (e.type) {
            case "run.start":
              return emit([
                { type: "response.created", response: snapshot("in_progress") },
                {
                  type: "response.in_progress",
                  response: snapshot("in_progress"),
                },
              ]);
            case "block.start": {
              if (e.kind === "reasoning") {
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
              blocks.set(e.id, { item, index });
              const events: ResponsesEvent[] = [
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
            case "block.delta": {
              const b = blocks.get(e.id);
              if (!b || b.item.type !== "message") return [];
              b.item.content[0]!.text += e.text;
              return emit([
                {
                  type: "response.output_text.delta",
                  item_id: b.item.id,
                  output_index: b.index,
                  content_index: 0,
                  delta: e.text,
                },
              ]);
            }
            case "block.end": {
              const b = blocks.get(e.id);
              if (!b || b.item.type !== "message") return [];
              const part = b.item.content[0]!;
              b.item.status = "completed";
              return emit([
                {
                  type: "response.output_text.done",
                  item_id: b.item.id,
                  output_index: b.index,
                  content_index: 0,
                  text: part.text,
                },
                {
                  type: "response.content_part.done",
                  item_id: b.item.id,
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
            case "tool.start": {
              const item: ResponseItem = {
                type: "function_call",
                id: `fc_${items.length}`,
                call_id: e.id,
                name: e.name,
                arguments: "",
                status: "in_progress",
              };
              const index = items.length;
              items.push(item);
              blocks.set(e.id, { item, index });
              return emit([
                {
                  type: "response.output_item.added",
                  output_index: index,
                  item: structuredClone(item),
                },
              ]);
            }
            case "tool.delta": {
              const b = blocks.get(e.id);
              if (!b || b.item.type !== "function_call")
                throw new Error("Tool delta without start.");
              b.item.arguments += e.text;
              return emit([
                {
                  type: "response.function_call_arguments.delta",
                  item_id: b.item.id,
                  output_index: b.index,
                  delta: e.text,
                },
              ]);
            }
            case "tool.end": {
              const b = blocks.get(e.id);
              if (!b || b.item.type !== "function_call")
                throw new Error("Tool end without start.");
              b.item.status = "completed";
              return emit([
                {
                  type: "response.function_call_arguments.done",
                  item_id: b.item.id,
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
            case "usage":
              usage = {
                input_tokens: e.input ?? 0,
                output_tokens: e.output ?? 0,
                total_tokens: e.total ?? (e.input ?? 0) + (e.output ?? 0),
              };
              return [];
            case "run.end": {
              const incomplete = [
                "length",
                "max_tokens",
                "max_output_tokens",
              ].includes(e.reason);
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
            case "error":
              return emit([
                {
                  type: "response.failed",
                  response: {
                    ...snapshot("failed"),
                    error: {
                      code: e.code ?? "conversion_error",
                      message: e.message,
                    },
                  },
                },
              ]);
            default:
              await context.unsupported(
                e,
                `Responses output cannot represent ${e.type}.`,
              );
              return [];
          }
        },
        finish: () => [],
      };
    },
  };
}
