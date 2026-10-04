import { chatCompletions, responses } from "eventport/openai";
import { anthropic } from "eventport/anthropic";
import { agUI } from "eventport/agui";
import { aiSDK } from "eventport/vercel";
import { langGraph } from "eventport/langgraph";
export const adapters = {
  "chat-completions": chatCompletions,
  responses,
  anthropic,
  agui: () => agUI({ threadId: "thread_demo", runId: "run_demo" }),
  "ai-sdk": aiSDK,
  langgraph: langGraph,
};
export const text = (events) =>
  events
    .filter((e) => e.type === "text-delta")
    .map((e) => e.delta)
    .join("");
export const calls = (events) =>
  events
    .filter((e) => e.type === "tool-input-available")
    .map((e) => ({ name: e.toolName, input: e.input }));
export async function* live(events) {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}
export function readable(events) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index === events.length) controller.close();
      else controller.enqueue(events[index++]);
    },
  });
}
