import type { Adapter, CanonicalEvent } from "../types.js";
import { json, key, Lifecycle, sse, unsupported } from "../internal.js";

export interface AGUIInterrupt {
  id: string;
  reason: string;
  message?: string;
  toolCallId?: string;
  responseSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
export type AGUIEvent =
  | { type: "RUN_STARTED"; threadId: string; runId: string }
  | {
      type: "RUN_FINISHED";
      threadId: string;
      runId: string;
      outcome?:
        | { type: "success" }
        | { type: "interrupt"; interrupts: AGUIInterrupt[] };
    }
  | { type: "RUN_ERROR"; message: string; code?: string }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
  | { type: "REASONING_MESSAGE_START"; messageId: string; role: "reasoning" }
  | {
      type: "TEXT_MESSAGE_CONTENT" | "REASONING_MESSAGE_CONTENT";
      messageId: string;
      delta: string;
    }
  | { type: "TEXT_MESSAGE_END" | "REASONING_MESSAGE_END"; messageId: string }
  | {
      type: "TOOL_CALL_START";
      toolCallId: string;
      toolCallName: string;
      parentMessageId?: string;
    }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string }
  | {
      type: "TOOL_CALL_RESULT";
      messageId: string;
      toolCallId: string;
      content: string;
      role: "tool";
    }
  | { type: "STEP_STARTED" | "STEP_FINISHED"; stepName: string }
  | { type: "STATE_SNAPSHOT"; snapshot: unknown }
  | { type: "STATE_DELTA"; delta: unknown[] }
  | { type: "CUSTOM"; name: string; value: unknown }
  | { type: "RAW"; event: unknown; source?: string };

export interface AGUIOptions {
  threadId: string;
  runId: string;
}
export function agUI(options: AGUIOptions): Adapter<AGUIEvent> {
  if (!options.threadId || !options.runId)
    throw new TypeError("agUI requires nonempty threadId and runId.");
  return {
    name: "ag-ui",
    key,
    wire: { frame: sse },
    decoder(context) {
      const life = new Lifecycle();
      return {
        async push(e) {
          switch (e.type) {
            case "RUN_STARTED":
              return life.start(e.runId);
            case "RUN_FINISHED": {
              const requests: CanonicalEvent[] =
                e.outcome?.type === "interrupt"
                  ? e.outcome.interrupts.map((i) => ({
                      type: "interaction.requested",
                      id: i.id,
                      toolCallId: i.toolCallId,
                      kind: i.reason === "approval" ? "approval" : "question",
                      payload: i,
                    }))
                  : [];
              return [
                ...requests,
                ...life.end(requests.length ? "waiting" : "stop"),
              ];
            }
            case "RUN_ERROR":
              life.ended = true;
              return [{ type: "error", message: e.message, code: e.code }];
            case "TEXT_MESSAGE_START":
            case "REASONING_MESSAGE_START":
              return life.block(
                e.messageId,
                e.type === "TEXT_MESSAGE_START" ? "text" : "reasoning",
                e.messageId,
              );
            case "TEXT_MESSAGE_CONTENT":
            case "REASONING_MESSAGE_CONTENT":
              if (!life.blocks.has(e.messageId))
                throw new Error("AG-UI content without message start.");
              return life.delta(
                e.messageId,
                e.delta,
                e.type === "TEXT_MESSAGE_CONTENT" ? "text" : "reasoning",
                e.messageId,
              );
            case "TEXT_MESSAGE_END":
            case "REASONING_MESSAGE_END":
              return life.endBlock(e.messageId);
            case "TOOL_CALL_START":
              return life.tool(e.toolCallId, e.toolCallName, e.parentMessageId);
            case "TOOL_CALL_ARGS":
              return life.toolDelta(e.toolCallId, e.delta);
            case "TOOL_CALL_END":
              return life.endTool(e.toolCallId);
            case "TOOL_CALL_RESULT":
              return [
                { type: "tool.result", id: e.toolCallId, result: e.content },
              ];
            case "STATE_SNAPSHOT":
              return [
                ...life.start(),
                { type: "state.snapshot", value: e.snapshot },
              ];
            case "STATE_DELTA":
              return [...life.start(), { type: "state.patch", patch: e.delta }];
            case "STEP_STARTED":
            case "STEP_FINISHED":
              return [
                ...life.start(),
                {
                  type: e.type === "STEP_STARTED" ? "step.start" : "step.end",
                  id: e.stepName,
                },
              ];
            case "CUSTOM":
              return [
                ...life.start(),
                { type: "custom", name: e.name, value: e.value },
              ];
            case "RAW":
              return [
                ...life.start(),
                {
                  type: "opaque",
                  protocol: e.source ?? "ag-ui",
                  payload: e.event,
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
      const blocks = new Map<string, "text" | "reasoning">();
      const interrupts: AGUIInterrupt[] = [];
      return {
        async push(e) {
          switch (e.type) {
            case "run.start":
              return [{ type: "RUN_STARTED", ...options }];
            case "run.end":
              if (
                [
                  "length",
                  "max_tokens",
                  "max_output_tokens",
                  "aborted",
                ].includes(e.reason)
              )
                return [
                  {
                    type: "CUSTOM",
                    name: "eventport.finish",
                    value: { reason: e.reason },
                  },
                  { type: "RUN_FINISHED", ...options },
                ];
              return [
                {
                  type: "RUN_FINISHED",
                  ...options,
                  ...(interrupts.length
                    ? { outcome: { type: "interrupt" as const, interrupts } }
                    : {}),
                },
              ];
            case "block.start":
              blocks.set(e.id, e.kind);
              return e.kind === "text"
                ? [
                    {
                      type: "TEXT_MESSAGE_START",
                      messageId: e.id,
                      role: "assistant",
                    },
                  ]
                : [
                    {
                      type: "REASONING_MESSAGE_START",
                      messageId: e.id,
                      role: "reasoning",
                    },
                  ];
            case "block.delta": {
              const kind = blocks.get(e.id);
              if (!kind) throw new Error("Block delta without start.");
              return [
                {
                  type:
                    kind === "text"
                      ? "TEXT_MESSAGE_CONTENT"
                      : "REASONING_MESSAGE_CONTENT",
                  messageId: e.id,
                  delta: e.text,
                },
              ];
            }
            case "block.end": {
              const kind = blocks.get(e.id);
              if (!kind) throw new Error("Block end without start.");
              blocks.delete(e.id);
              return [
                {
                  type:
                    kind === "text"
                      ? "TEXT_MESSAGE_END"
                      : "REASONING_MESSAGE_END",
                  messageId: e.id,
                },
              ];
            }
            case "block.metadata":
              return [
                { type: "CUSTOM", name: "eventport.block-metadata", value: e },
              ];
            case "tool.start":
              return [
                {
                  type: "TOOL_CALL_START",
                  toolCallId: e.id,
                  toolCallName: e.name,
                  parentMessageId: e.messageId,
                },
              ];
            case "tool.delta":
              return [
                { type: "TOOL_CALL_ARGS", toolCallId: e.id, delta: e.text },
              ];
            case "tool.end":
              return [{ type: "TOOL_CALL_END", toolCallId: e.id }];
            case "tool.result":
              if (e.isError)
                await context.unsupported(
                  e,
                  "AG-UI tool results do not have a standard error flag.",
                );
              return [
                {
                  type: "TOOL_CALL_RESULT",
                  messageId: `result_${e.id}`,
                  toolCallId: e.id,
                  content: json(e.result),
                  role: "tool",
                },
              ];
            case "usage":
              return [{ type: "CUSTOM", name: "eventport.usage", value: e }];
            case "state.snapshot":
              return [{ type: "STATE_SNAPSHOT", snapshot: e.value }];
            case "state.patch":
              return [{ type: "STATE_DELTA", delta: e.patch }];
            case "step.start":
            case "step.end":
              return [
                {
                  type:
                    e.type === "step.start" ? "STEP_STARTED" : "STEP_FINISHED",
                  stepName: e.id,
                },
              ];
            case "interaction.requested":
              interrupts.push({
                id: e.id,
                reason: e.kind,
                toolCallId: e.toolCallId,
                metadata: { eventport: e.payload },
              });
              return [];
            case "custom":
              return [{ type: "CUSTOM", name: e.name, value: e.value }];
            case "opaque":
              return [{ type: "RAW", source: e.protocol, event: e.payload }];
            case "error":
              return [{ type: "RUN_ERROR", message: e.message, code: e.code }];
          }
        },
        finish: () => [],
      };
    },
  };
}
