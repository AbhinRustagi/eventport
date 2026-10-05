import type { EventType } from "@ag-ui/core";
import {
  toolResult,
  readInteraction,
  finishReason,
  resultValue,
  resultIsError,
} from "../protocol.js";
import type { Adapter, CanonicalEvent } from "../types.js";
import {
  key,
  Lifecycle,
  parseArguments,
  sse,
  unsupported,
} from "../internal.js";

import type { UIMessageChunk } from "ai";
/** UIMessage stream protocol, not AI SDK Core fullStream. */
export type AISDKEvent = UIMessageChunk;

export function aiSDK(): Adapter<AISDKEvent> {
  return {
    name: "ai-sdk",
    key,
    wire: {
      frame: sse,
      end: "data: [DONE]\n\n",
      headers: { "x-vercel-ai-uimessage-stream": "v1" },
    },
    decoder(context) {
      const life = new Lifecycle();
      let message = life.id,
        step = 0;
      const args = new Map<string, string>();
      return {
        async push(e) {
          switch (e.type) {
            case "start":
              message = e.messageId ?? message;
              return life.start(message);
            case "finish":
              return life.end(e.finishReason ?? "stop");
            case "text-start":
            case "reasoning-start":
              return life.block(
                e.id,
                e.type === "text-start" ? "text" : "reasoning",
                message,
              );
            case "text-delta":
            case "reasoning-delta":
              if (!life.blocks.has(e.id))
                throw new Error("AI SDK delta without start.");
              return life.delta(
                e.id,
                e.delta,
                e.type === "text-delta" ? "text" : "reasoning",
                message,
              );
            case "text-end":
            case "reasoning-end":
              return life.endBlock(e.id);
            case "tool-input-start":
              args.set(e.toolCallId, "");
              return life.tool(e.toolCallId, e.toolName, message);
            case "tool-input-delta":
              args.set(
                e.toolCallId,
                (args.get(e.toolCallId) ?? "") + e.inputTextDelta,
              );
              return life.toolDelta(e.toolCallId, e.inputTextDelta);
            case "tool-input-available": {
              const out: CanonicalEvent[] = [];
              if (!life.tools.has(e.toolCallId))
                out.push(...life.tool(e.toolCallId, e.toolName, message));
              const accumulated = args.get(e.toolCallId);
              if (!accumulated)
                out.push(
                  ...life.toolDelta(e.toolCallId, JSON.stringify(e.input)),
                );
              else if (
                JSON.stringify(parseArguments(accumulated)) !==
                JSON.stringify(e.input)
              )
                throw new Error(
                  "Completed tool input disagrees with its streamed arguments.",
                );
              args.delete(e.toolCallId);
              return [...out, ...life.endTool(e.toolCallId)];
            }
            case "tool-output-available":
              return [toolResult(e.toolCallId, e.output, false)];
            case "tool-output-error":
              return [toolResult(e.toolCallId, e.errorText, true)];
            case "tool-approval-request":
              return [
                life.interaction({
                  id: e.approvalId,
                  toolCallId: e.toolCallId,
                  kind: "approval",
                  payload: e,
                }),
              ];
            case "start-step":
              return [
                ...life.start(),
                {
                  type: "STEP_STARTED" as EventType.STEP_STARTED,
                  stepName: `step_${++step}`,
                },
              ];
            case "finish-step":
              return [
                ...life.closeContent(),
                {
                  type: "STEP_FINISHED" as EventType.STEP_FINISHED,
                  stepName: `step_${step}`,
                },
              ];
            case "abort":
              return life.end("aborted");
            case "error":
              life.ended = true;
              return [
                {
                  type: "RUN_ERROR" as EventType.RUN_ERROR,
                  message: e.errorText,
                },
              ];
            default:
              if (e.type.startsWith("data-") && "data" in e)
                return [
                  ...life.start(),
                  {
                    type: "CUSTOM" as EventType.CUSTOM,
                    name: e.type.slice(5),
                    value: e.data,
                  },
                ];
              return unsupported(context, e);
          }
        },
        finish: () => life.finish(),
      };
    },
    encoder(context) {
      const kinds = new Map<string, "text" | "reasoning">();
      const tools = new Map<string, { name: string; args: string }>();
      const approvals = new Set<string>();
      const approval = async (value: {
        id: string;
        kind: string;
        toolCallId?: string;
      }): Promise<AISDKEvent[]> => {
        if (approvals.has(value.id)) return [];
        approvals.add(value.id);
        if (value.kind === "approval" && value.toolCallId)
          return [
            {
              type: "tool-approval-request",
              approvalId: value.id,
              toolCallId: value.toolCallId,
            },
          ];
        await context.unsupported(
          value,
          "AI SDK tool approvals require a toolCallId; questions need application-specific data.",
        );
        return [];
      };
      return {
        async push(e): Promise<AISDKEvent[]> {
          const interaction = readInteraction(e);
          if (interaction) return approval(interaction);
          switch (e.type) {
            case "RUN_STARTED":
              return [{ type: "start", messageId: e.runId }];
            case "RUN_FINISHED": {
              const requests: AISDKEvent[] = [];
              if (e.outcome?.type === "interrupt")
                for (const i of e.outcome.interrupts)
                  requests.push(...(await approval({ ...i, kind: i.reason })));
              return [
                ...requests,
                ...(finishReason(e) === "aborted"
                  ? [{ type: "abort" as const, reason: "Upstream cancelled" }]
                  : [
                      {
                        type: "finish" as const,
                        finishReason: [
                          "length",
                          "max_tokens",
                          "max_output_tokens",
                        ].includes(finishReason(e))
                          ? ("length" as const)
                          : finishReason(e) === "tool_use" ||
                              finishReason(e) === "tool_calls"
                            ? ("tool-calls" as const)
                            : ("stop" as const),
                      },
                    ]),
              ];
            }
            case "TEXT_MESSAGE_START":
            case "REASONING_MESSAGE_START":
              kinds.set(
                e.messageId,
                e.type === "TEXT_MESSAGE_START" ? "text" : "reasoning",
              );
              return [
                {
                  type:
                    e.type === "TEXT_MESSAGE_START"
                      ? "text-start"
                      : "reasoning-start",
                  id: e.messageId,
                },
              ];
            case "TEXT_MESSAGE_CONTENT":
            case "REASONING_MESSAGE_CONTENT": {
              const kind = kinds.get(e.messageId);
              if (!kind) throw new Error("Block delta without start.");
              return [
                {
                  type: kind === "text" ? "text-delta" : "reasoning-delta",
                  id: e.messageId,
                  delta: e.delta,
                },
              ];
            }
            case "TEXT_MESSAGE_END":
            case "REASONING_MESSAGE_END": {
              const kind = kinds.get(e.messageId);
              if (!kind) throw new Error("Block end without start.");
              kinds.delete(e.messageId);
              return [
                {
                  type: kind === "text" ? "text-end" : "reasoning-end",
                  id: e.messageId,
                },
              ];
            }
            case "TOOL_CALL_START":
              tools.set(e.toolCallId, { name: e.toolCallName, args: "" });
              return [
                {
                  type: "tool-input-start",
                  toolCallId: e.toolCallId,
                  toolName: e.toolCallName,
                  dynamic: true,
                },
              ];
            case "TOOL_CALL_ARGS": {
              const tool = tools.get(e.toolCallId);
              if (!tool) throw new Error("Tool delta without start.");
              tool.args += e.delta;
              return [
                {
                  type: "tool-input-delta",
                  toolCallId: e.toolCallId,
                  inputTextDelta: e.delta,
                },
              ];
            }
            case "TOOL_CALL_END": {
              const tool = tools.get(e.toolCallId);
              if (!tool) throw new Error("Tool end without start.");
              tools.delete(e.toolCallId);
              return [
                {
                  type: "tool-input-available",
                  toolCallId: e.toolCallId,
                  toolName: tool.name,
                  input: parseArguments(tool.args),
                  dynamic: true,
                },
              ];
            }
            case "TOOL_CALL_RESULT":
              return resultIsError(e)
                ? [
                    {
                      type: "tool-output-error",
                      toolCallId: e.toolCallId,
                      errorText: String(resultValue(e)),
                    },
                  ]
                : [
                    {
                      type: "tool-output-available",
                      toolCallId: e.toolCallId,
                      output: resultValue(e),
                      dynamic: true,
                    },
                  ];
            case "STEP_STARTED":
              return [{ type: "start-step" }];
            case "STEP_FINISHED":
              return [{ type: "finish-step" }];
            case "CUSTOM":
              return [
                {
                  type: `data-${e.name === "eventport.usage" ? "eventport-usage" : e.name === "eventport.block-metadata" ? "eventport-block-metadata" : e.name}`,
                  data: e.value,
                },
              ];
            case "STATE_SNAPSHOT":
            case "STATE_DELTA":
              return [
                {
                  type: `data-eventport-${e.type.toLowerCase().replaceAll("_", "-")}`,
                  data: e,
                },
              ];
            case "RAW":
              return [{ type: "data-eventport-opaque", data: e }];
            case "RUN_ERROR":
              return [{ type: "error", errorText: e.message }];
            default:
              await context.unsupported(
                e,
                `AI SDK cannot represent ${e.type}.`,
              );
              return [];
          }
        },
        finish: () => [],
      };
    },
  };
}
