import type { Adapter, CanonicalEvent } from "../types.js";
import { Lifecycle, sse, unsupported } from "../internal.js";

export interface ChatCompletionChunk {
  object: "chat.completion.chunk";
  id: string;
  created?: number;
  model?: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ index: number; id?: string; type?: "function"; function?: { name?: string; arguments?: string } }>;
      [extension: string]: unknown;
    };
    finish_reason?: string | null;
    logprobs?: unknown;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; [key: string]: unknown } | null;
}
export interface ChatCompletionsOptions { model?: string; id?: string }
/** One choice per conversion. Multiple choices are rejected rather than merged. */
export function chatCompletions(options: ChatCompletionsOptions = {}): Adapter<ChatCompletionChunk> {
  return {
    name: "chat-completions", key: e => e.object,
    wire: { frame: sse, end: "data: [DONE]\n\n" },
    decoder(context) {
      const life = new Lifecycle();
      const tools = new Map<number, { id: string; name: string; pending: string; started: boolean }>();
      let reason: string | undefined;
      return {
        async push(e) {
          if (e.object !== "chat.completion.chunk") return unsupported(context, e);
          const out: CanonicalEvent[] = [];
          if (e.usage) out.push({ type: "usage", input: e.usage.prompt_tokens, output: e.usage.completion_tokens, total: e.usage.total_tokens, details: e.usage });
          for (const choice of e.choices) {
            if (choice.index !== 0) { await context.unsupported(choice, "Only choice index 0 is supported; split n>1 responses before conversion."); continue; }
            if (reason !== undefined) throw new Error("Chat content received after finish_reason.");
            out.push(...life.start(e.id));
            const d = choice.delta;
            for (const k of Object.keys(d)) if (!["role", "content", "tool_calls"].includes(k) && d[k] != null) await context.unsupported({ [k]: d[k] }, `Unsupported Chat Completions delta field: ${k}`);
            if (choice.logprobs != null) await context.unsupported(choice.logprobs, "Log probabilities have no mapping.");
            if (d.content) out.push(...life.delta(`${e.id}:text`, d.content, "text", e.id));
            for (const call of d.tool_calls ?? []) {
              const t = tools.get(call.index) ?? { id: "", name: "", pending: "", started: false };
              if (call.id) { if (t.id && t.id !== call.id) throw new Error("Tool ID changed within a call."); t.id = call.id; }
              if (call.function?.name) t.name += call.function.name;
              t.pending += call.function?.arguments ?? "";
              if (!t.started && t.id && t.name) { out.push(...life.tool(t.id, t.name, e.id)); t.started = true; }
              if (t.started && t.pending) { out.push(...life.toolDelta(t.id, t.pending)); t.pending = ""; }
              tools.set(call.index, t);
            }
            if (choice.finish_reason) reason = choice.finish_reason;
          }
          return out;
        },
        finish() {
          if ([...tools.values()].some(t => !t.started || t.pending)) throw new Error("Incomplete tool identity in Chat Completions stream.");
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
      const chunk = (delta: ChatCompletionChunk["choices"][number]["delta"], finish_reason: string | null = null): ChatCompletionChunk => ({ id, object: "chat.completion.chunk", created, model: options.model ?? "unknown", choices: [{ index: 0, delta, finish_reason, logprobs: null }] });
      return {
        async push(e) {
          switch (e.type) {
            case "run.start": if (!options.id) id = e.id; return [chunk({ role: "assistant", content: "" })];
            case "block.start":
              kinds.set(e.id, e.kind);
              if (e.kind === "reasoning") await context.unsupported(e, "Standard Chat Completions has no reasoning block representation.");
              return [];
            case "block.delta": return kinds.get(e.id) === "text" ? [chunk({ content: e.text })] : [];
            case "block.end": kinds.delete(e.id); return [];
            case "tool.start": { const index = toolIndexes.size; toolIndexes.set(e.id, index); return [chunk({ tool_calls: [{ index, id: e.id, type: "function", function: { name: e.name, arguments: "" } }] })]; }
            case "tool.delta": {
              const index = toolIndexes.get(e.id); if (index === undefined) throw new Error("Tool delta without start.");
              return [chunk({ tool_calls: [{ index, function: { arguments: e.text } }] })];
            }
            case "tool.end": return [];
            case "usage": usage = { prompt_tokens: e.input ?? 0, completion_tokens: e.output ?? 0, total_tokens: e.total ?? (e.input ?? 0) + (e.output ?? 0) }; return [];
            case "run.end": {
              const finish = e.reason === "length" || e.reason === "max_tokens" ? "length" : toolIndexes.size ? "tool_calls" : "stop";
              const out = [chunk({}, finish)];
              if (usage) out.push({ ...chunk({}), choices: [], usage });
              return out;
            }
            default: await context.unsupported(e, `Chat Completions cannot represent ${e.type}.`); return [];
          }
        }, finish: () => [],
      };
    },
  };
}
