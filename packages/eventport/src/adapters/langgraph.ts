import type { EventType } from "@ag-ui/core";
import { toolResult } from "../protocol.js";
import type { CanonicalEvent, SourceAdapter } from "../types.js";
import { Lifecycle, object, unsupported } from "../internal.js";

import type {
  Message,
  MessagesTupleStreamEvent,
  ValuesStreamEvent,
  CustomStreamEvent,
  MetadataStreamEvent,
  ErrorStreamEvent,
} from "@langchain/langgraph-sdk";
import type { ToolCallChunk } from "@langchain/core/messages";
/** LangGraph serializes chunk fields but its Message union omits tool_call_chunks. */
type WithChunkFields<M> = M extends { type: "ai" }
  ? M & { tool_call_chunks?: ToolCallChunk[] }
  : M;
export type LangGraphMessage = WithChunkFields<Message>;
type MessageEvent = Omit<MessagesTupleStreamEvent, "data"> & {
  data: [LangGraphMessage, MessagesTupleStreamEvent["data"][1]];
};
export type LangGraphEvent =
  | MessageEvent
  | (Omit<MessageEvent, "event"> & { event: "messages-tuple" })
  | ValuesStreamEvent<Record<string, unknown>>
  | CustomStreamEvent<unknown>
  | MetadataStreamEvent
  | ErrorStreamEvent;
export type LangGraphTuple = {
  [K in LangGraphEvent["event"]]: [
    K,
    Extract<LangGraphEvent, { event: K }> extends never
      ? [LangGraphMessage, Record<string, unknown>]
      : Extract<LangGraphEvent, { event: K }>["data"],
  ];
}[LangGraphEvent["event"]];

export function langGraph(options?: {
  input?: "events";
}): SourceAdapter<LangGraphEvent>;
export function langGraph(options: {
  input: "tuples";
}): SourceAdapter<LangGraphTuple>;
export function langGraph(
  options: { input?: "events" | "tuples" } = {},
): SourceAdapter<LangGraphEvent | LangGraphTuple> {
  return {
    name: "langgraph",
    isEvent: (value): value is LangGraphEvent | LangGraphTuple =>
      options.input === "tuples" &&
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string",
    key: (e) => (Array.isArray(e) ? e[0] : e.event),
    decoder(context) {
      const life = new Lifecycle();
      const callIds = new Map<string, string[]>();
      const tools = new Map<
        string,
        { id: string; name: string; started: boolean; pending: string }
      >();
      let interrupted = false;
      return {
        async push(input) {
          const e = (
            options.input === "tuples" && Array.isArray(input)
              ? { event: input[0], data: input[1] }
              : input
          ) as LangGraphEvent;
          const out: CanonicalEvent[] = [];
          switch (e.event) {
            case "metadata":
              return life.start(
                typeof e.data.run_id === "string" ? e.data.run_id : life.id,
              );
            case "messages":
            case "messages-tuple": {
              const [message, metadata] = e.data;
              // Namespace + step disambiguate IDs reused by separate subgraph invocations.
              const namespace = String(metadata.langgraph_checkpoint_ns ?? "");
              const scope = JSON.stringify([
                metadata.langgraph_checkpoint_ns ?? "",
                metadata.langgraph_step ?? "",
                metadata.langgraph_node ?? "",
              ]);
              if (!message.id)
                throw new Error(
                  "LangGraph messages require a stable id; supply one in source middleware.",
                );
              const messageId = `${scope}:${message.id}`;
              out.push(...life.start());
              if (message.type === "tool") {
                if (!message.tool_call_id)
                  throw new Error("Tool result requires tool_call_id.");
                const lookup = `${namespace}:${message.tool_call_id}`;
                const candidates = callIds.get(lookup) ?? [];
                if (candidates.length !== 1)
                  throw new Error(
                    "Missing or ambiguous LangGraph tool result identity.",
                  );
                const id = candidates[0]!;
                callIds.delete(lookup);
                return [
                  ...out,
                  ...(life.tools.has(id) ? life.endTool(id) : []),
                  toolResult(id, message.content, message.status === "error"),
                ];
              }
              if (
                message.type &&
                !["ai", "ToolCallChunk", "AIMessage"].includes(message.type)
              )
                return unsupported(
                  context,
                  e,
                  "Only assistant and tool messages are supported.",
                );
              if (typeof message.content === "string") {
                if (message.content)
                  out.push(
                    ...life.delta(
                      `${messageId}:text`,
                      message.content,
                      "text",
                      messageId,
                    ),
                  );
              } else {
                for (const [index, rawBlock] of message.content.entries()) {
                  const block = object(rawBlock);
                  const reasoning = block.thinking ?? block.text;
                  const blockId = `${messageId}:${block.index ?? index}:${block.type}`;
                  if (block.type === "text" && typeof block.text === "string")
                    out.push(
                      ...life.delta(blockId, block.text, "text", messageId),
                    );
                  else if (
                    (block.type === "thinking" || block.type === "reasoning") &&
                    typeof reasoning === "string"
                  )
                    out.push(
                      ...life.delta(blockId, reasoning, "reasoning", messageId),
                    );
                  else
                    await context.unsupported(
                      block,
                      "Unsupported LangGraph content block.",
                    );
                }
              }
              for (const call of (message.type === "ai"
                ? message.tool_call_chunks
                : undefined) ?? []) {
                const lookup = `${messageId}:${call.index ?? call.id ?? 0}`;
                const tool = tools.get(lookup) ?? {
                  id: "",
                  name: "",
                  started: false,
                  pending: "",
                };
                if (call.id) tool.id = `${scope}:${call.id}`;
                if (call.name) tool.name += call.name;
                tool.pending += call.args ?? "";
                if (!tool.started && tool.id && tool.name) {
                  out.push(...life.tool(tool.id, tool.name, messageId));
                  tool.started = true;
                  const alias = `${namespace}:${call.id ?? tool.id.slice(scope.length + 1)}`;
                  callIds.set(alias, [...(callIds.get(alias) ?? []), tool.id]);
                }
                if (tool.started && tool.pending) {
                  out.push(...life.toolDelta(tool.id, tool.pending));
                  tool.pending = "";
                }
                tools.set(lookup, tool);
              }
              if (message.type === "ai" && !message.tool_call_chunks?.length)
                for (const call of message.tool_calls ?? []) {
                  if (!call.id)
                    throw new Error("LangGraph tool call requires an id.");
                  const id = `${scope}:${call.id}`;
                  const alias = `${namespace}:${call.id}`;
                  callIds.set(alias, [...(callIds.get(alias) ?? []), id]);
                  out.push(
                    ...life.tool(id, call.name, messageId),
                    ...life.toolDelta(id, JSON.stringify(call.args)),
                    ...life.endTool(id),
                  );
                }
              return out;
            }
            case "values": {
              if (Array.isArray(e.data.__interrupt__)) {
                interrupted = true;
                for (const item of e.data.__interrupt__) {
                  const interrupt = object(item);
                  if (typeof interrupt.id !== "string")
                    throw new Error("LangGraph interrupt requires an id.");
                  out.push(
                    life.interaction({
                      id: interrupt.id,
                      kind: "question",
                      payload: interrupt.value,
                    }),
                  );
                }
              }
              return [
                ...life.start(),
                {
                  type: "STATE_SNAPSHOT" as EventType.STATE_SNAPSHOT,
                  snapshot: e.data,
                },
                ...out,
              ];
            }
            case "custom":
              return [
                ...life.start(),
                {
                  type: "CUSTOM" as EventType.CUSTOM,
                  name: "langgraph",
                  value: e.data,
                },
              ];
            case "error":
              life.ended = true;
              return [
                {
                  type: "RUN_ERROR" as EventType.RUN_ERROR,
                  message: e.data.message ?? e.data.error ?? "LangGraph error",
                },
              ];
            default:
              return unsupported(
                context,
                e,
                "Unsupported LangGraph stream mode. Use messages, values, custom or metadata envelopes.",
              );
          }
        },
        finish() {
          if ([...tools.values()].some((t) => !t.started || t.pending))
            throw new Error("Incomplete LangGraph tool identity.");
          // LangGraph iterator exhaustion is the run boundary (unlike provider SSE).
          return life.ended ? [] : life.end(interrupted ? "waiting" : "stop");
        },
      };
    },
  };
}
