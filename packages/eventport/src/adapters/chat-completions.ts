import { usageEvent, readUsage, finishReason } from "../protocol.js";
import type { Adapter, CanonicalEvent } from "../types.js";
import { Lifecycle, sse, unsupported } from "../internal.js";

import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";
export type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";
export interface ChatCompletionsOptions {
  model?: string;
  id?: string;
}
/** One choice per conversion. Multiple choices are rejected rather than merged. */
export function chatCompletions(
  options: ChatCompletionsOptions = {},
): Adapter<ChatCompletionChunk> {
  return {
    name: "chat-completions",
    key: (e) => e.object,
    wire: { frame: sse, end: "data: [DONE]\n\n" },
    decoder(context) {
      const life = new Lifecycle();
      const tools = new Map<
        number,
        { id: string; name: string; pending: string; started: boolean }
      >();
      let reason: string | undefined;
      return {
        async push(e) {
          if (e.object !== "chat.completion.chunk")
            return unsupported(context, e);
          const out: CanonicalEvent[] = [];
          if (e.usage)
            out.push(
              usageEvent({
                input: e.usage.prompt_tokens,
                output: e.usage.completion_tokens,
                total: e.usage.total_tokens,
                details: e.usage,
              }),
            );
          for (const choice of e.choices) {
            if (choice.index !== 0) {
              await context.unsupported(
                choice,
                "Only choice index 0 is supported; split n>1 responses before conversion.",
              );
              continue;
            }
            if (reason !== undefined)
              throw new Error("Chat content received after finish_reason.");
            out.push(...life.start(e.id));
            const d = choice.delta;
            for (const [k, value] of Object.entries(d))
              if (
                !["role", "content", "tool_calls"].includes(k) &&
                value != null
              )
                await context.unsupported(
                  { [k]: value },
                  `Unsupported Chat Completions delta field: ${k}`,
                );
            if (choice.logprobs != null)
              await context.unsupported(
                choice.logprobs,
                "Log probabilities have no mapping.",
              );
            if (d.content)
              out.push(...life.delta(`${e.id}:text`, d.content, "text", e.id));
            for (const call of d.tool_calls ?? []) {
              const t = tools.get(call.index) ?? {
                id: "",
                name: "",
                pending: "",
                started: false,
              };
              if (call.id) {
                if (t.id && t.id !== call.id)
                  throw new Error("Tool ID changed within a call.");
                t.id = call.id;
              }
              if (call.function?.name) t.name += call.function.name;
              t.pending += call.function?.arguments ?? "";
              if (!t.started && t.id && t.name) {
                out.push(...life.tool(t.id, t.name, e.id));
                t.started = true;
              }
              if (t.started && t.pending) {
                out.push(...life.toolDelta(t.id, t.pending));
                t.pending = "";
              }
              tools.set(call.index, t);
            }
            if (choice.finish_reason) reason = choice.finish_reason;
          }
          return out;
        },
        finish() {
          if ([...tools.values()].some((t) => !t.started || t.pending))
            throw new Error(
              "Incomplete tool identity in Chat Completions stream.",
            );
          return reason !== undefined ? life.end(reason) : life.finish();
        },
      };
    },
    encoder(context) {
      let id = options.id ?? `chatcmpl_${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const kinds = new Map<string, string>();
      const toolIndexes = new Map<string, number>();
      let usage: ChatCompletionChunk["usage"];
      const chunk = (
        delta: ChatCompletionChunk["choices"][number]["delta"],
        finish_reason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
      ): ChatCompletionChunk => ({
        id,
        object: "chat.completion.chunk",
        created,
        model: options.model ?? "unknown",
        choices: [{ index: 0, delta, finish_reason, logprobs: null }],
      });
      return {
        async push(e) {
          const tokenUsage = readUsage(e);
          if (tokenUsage) {
            usage = {
              prompt_tokens: tokenUsage.input ?? 0,
              completion_tokens: tokenUsage.output ?? 0,
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
              if (!options.id) id = e.runId;
              return [chunk({ role: "assistant", content: "" })];
            case "TEXT_MESSAGE_START":
            case "REASONING_MESSAGE_START":
              kinds.set(
                e.messageId,
                e.type === "TEXT_MESSAGE_START" ? "text" : "reasoning",
              );
              if (e.type === "REASONING_MESSAGE_START")
                await context.unsupported(
                  e,
                  "Standard Chat Completions has no reasoning block representation.",
                );
              return [];
            case "TEXT_MESSAGE_CONTENT":
            case "REASONING_MESSAGE_CONTENT":
              return kinds.get(e.messageId) === "text"
                ? [chunk({ content: e.delta })]
                : [];
            case "TEXT_MESSAGE_END":
            case "REASONING_MESSAGE_END":
              kinds.delete(e.messageId);
              return [];
            case "TOOL_CALL_START": {
              const index = toolIndexes.size;
              toolIndexes.set(e.toolCallId, index);
              return [
                chunk({
                  tool_calls: [
                    {
                      index,
                      id: e.toolCallId,
                      type: "function",
                      function: { name: e.toolCallName, arguments: "" },
                    },
                  ],
                }),
              ];
            }
            case "TOOL_CALL_ARGS": {
              const index = toolIndexes.get(e.toolCallId);
              if (index === undefined)
                throw new Error("Tool delta without start.");
              return [
                chunk({
                  tool_calls: [{ index, function: { arguments: e.delta } }],
                }),
              ];
            }
            case "TOOL_CALL_END":
              return [];
            case "RUN_FINISHED": {
              const finish =
                finishReason(e) === "length" || finishReason(e) === "max_tokens"
                  ? "length"
                  : toolIndexes.size
                    ? "tool_calls"
                    : "stop";
              const out = [chunk({}, finish)];
              if (usage) out.push({ ...chunk({}), choices: [], usage });
              return out;
            }
            default:
              await context.unsupported(
                e,
                `Chat Completions cannot represent ${e.type === "CUSTOM" ? e.name : e.type}.`,
              );
              return [];
          }
        },
        finish: () => [],
      };
    },
  };
}
