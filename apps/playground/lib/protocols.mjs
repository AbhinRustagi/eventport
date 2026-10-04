export const protocols = {
  responses: {
    label: "OpenAI Responses",
    factory: "responses()",
    path: "openai",
  },
  "chat-completions": {
    label: "Chat Completions",
    factory: "chatCompletions()",
    path: "openai",
  },
  anthropic: {
    label: "Anthropic Messages",
    factory: "anthropic()",
    path: "anthropic",
  },
  agui: { label: "AG-UI", factory: "agUI({ threadId, runId })", path: "agui" },
  "ai-sdk": { label: "Vercel AI SDK", factory: "aiSDK()", path: "vercel" },
  langgraph: { label: "LangGraph", factory: "langGraph()", path: "langgraph" },
};
