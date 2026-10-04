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
              return [
                { type: "tool.result", id: e.toolCallId, result: e.output },
              ];
            case "tool-output-error":
              return [
                {
                  type: "tool.result",
                  id: e.toolCallId,
                  result: e.errorText,
                  isError: true,
                },
              ];
            case "tool-approval-request":
              return [
                {
                  type: "interaction.requested",
                  id: e.approvalId,
                  toolCallId: e.toolCallId,
                  kind: "approval",
                  payload: e,
                },
              ];
            case "start-step":
              return [
                ...life.start(),
                { type: "step.start", id: `step_${++step}` },
              ];
            case "finish-step":
              return [
                ...life.closeContent(),
                { type: "step.end", id: `step_${step}` },
              ];
            case "abort":
              return life.end("aborted");
            case "error":
              life.ended = true;
              return [{ type: "error", message: e.errorText }];
            default:
              if (e.type.startsWith("data-") && "data" in e)
                return [
                  ...life.start(),
                  { type: "custom", name: e.type.slice(5), value: e.data },
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
      return {
        async push(e) {
          switch (e.type) {
            case "run.start":
              return [{ type: "start", messageId: e.id }];
            case "run.end":
              return e.reason === "aborted"
                ? [{ type: "abort", reason: "Upstream cancelled" }]
                : [
                    {
                      type: "finish",
                      finishReason: [
                        "length",
                        "max_tokens",
                        "max_output_tokens",
                      ].includes(e.reason)
                        ? "length"
                        : e.reason === "tool_use" || e.reason === "tool_calls"
                          ? "tool-calls"
                          : "stop",
                    },
                  ];
            case "block.start":
              kinds.set(e.id, e.kind);
              return [
                {
                  type: e.kind === "text" ? "text-start" : "reasoning-start",
                  id: e.id,
                },
              ];
            case "block.delta": {
              const kind = kinds.get(e.id);
              if (!kind) throw new Error("Block delta without start.");
              return [
                {
                  type: kind === "text" ? "text-delta" : "reasoning-delta",
                  id: e.id,
                  delta: e.text,
                },
              ];
            }
            case "block.end": {
              const kind = kinds.get(e.id);
              if (!kind) throw new Error("Block end without start.");
              kinds.delete(e.id);
              return [
                {
                  type: kind === "text" ? "text-end" : "reasoning-end",
                  id: e.id,
                },
              ];
            }
            case "tool.start":
              tools.set(e.id, { name: e.name, args: "" });
              return [
                {
                  type: "tool-input-start",
                  toolCallId: e.id,
                  toolName: e.name,
                  dynamic: true,
                },
              ];
            case "tool.delta": {
              const tool = tools.get(e.id);
              if (!tool) throw new Error("Tool delta without start.");
              tool.args += e.text;
              return [
                {
                  type: "tool-input-delta",
                  toolCallId: e.id,
                  inputTextDelta: e.text,
                },
              ];
            }
            case "tool.end": {
              const tool = tools.get(e.id);
              if (!tool) throw new Error("Tool end without start.");
              tools.delete(e.id);
              return [
                {
                  type: "tool-input-available",
                  toolCallId: e.id,
                  toolName: tool.name,
                  input: parseArguments(tool.args),
                  dynamic: true,
                },
              ];
            }
            case "tool.result":
              return e.isError
                ? [
                    {
                      type: "tool-output-error",
                      toolCallId: e.id,
                      errorText: String(e.result),
                    },
                  ]
                : [
                    {
                      type: "tool-output-available",
                      toolCallId: e.id,
                      output: e.result,
                      dynamic: true,
                    },
                  ];
            case "interaction.requested":
              if (e.kind === "approval" && e.toolCallId)
                return [
                  {
                    type: "tool-approval-request",
                    approvalId: e.id,
                    toolCallId: e.toolCallId,
                  },
                ];
              await context.unsupported(
                e,
                "AI SDK tool approvals require a toolCallId; questions need application-specific data.",
              );
              return [];
            case "step.start":
              return [{ type: "start-step" }];
            case "step.end":
              return [{ type: "finish-step" }];
            case "custom":
              return [{ type: `data-${e.name}`, data: e.value }];
            case "usage":
            case "block.metadata":
            case "state.snapshot":
            case "state.patch":
              return [
                {
                  type: `data-eventport-${e.type.replaceAll(".", "-")}`,
                  data: e,
                },
              ];
            case "opaque":
              return [{ type: "data-eventport-opaque", data: e }];
            case "error":
              return [{ type: "error", errorText: e.message }];
          }
        },
        finish: () => [],
      };
    },
  };
}
