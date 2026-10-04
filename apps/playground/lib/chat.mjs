import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { Client } from "@langchain/langgraph-sdk";
import {
  streamText,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { eventport } from "eventport";
import { responses, chatCompletions } from "eventport/openai";
import { anthropic } from "eventport/anthropic";
import { agUI } from "eventport/agui";
import { aiSDK } from "eventport/vercel";
import { langGraph } from "eventport/langgraph";
import { protocols } from "./protocols.mjs";

export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function parseChat(body) {
  if (
    !body ||
    !Object.hasOwn(protocols, body.protocol) ||
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.length > 100
  ) {
    throw new RequestError(
      "Choose a supported adapter and include 1–100 messages.",
    );
  }
  const messages = body.messages.map((message) => {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      !Array.isArray(message.parts)
    ) {
      throw new RequestError("Only user and assistant messages are accepted.");
    }
    if (
      message.parts.some(
        (part) =>
          !part ||
          typeof part.type !== "string" ||
          (part.type === "text" && typeof part.text !== "string"),
      )
    ) {
      throw new RequestError("Invalid message content.");
    }
    if (
      message.role === "user" &&
      message.parts.some((part) => part.type !== "text")
    ) {
      throw new RequestError("This playground accepts text messages only.");
    }
    const content = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (!content.trim() || content.length > 16_000)
      throw new RequestError(
        "Messages must contain 1–16,000 characters of text.",
      );
    return { role: message.role, content };
  });
  if (messages.at(-1).role !== "user")
    throw new RequestError("The last message must be from the user.");
  return { protocol: body.protocol, messages };
}

function required(env, name) {
  if (!env[name])
    throw new RequestError(
      `Set ${name} in apps/playground/.env.local to use this adapter.`,
      503,
    );
  return env[name];
}

// SDK clients are server-side only. The optional fetch is a test seam for real SDK transports.
export async function openSource({
  protocol,
  messages,
  signal,
  env = process.env,
  fetch = globalThis.fetch,
}) {
  if (protocol === "anthropic") {
    const client = new Anthropic({
      apiKey: required(env, "ANTHROPIC_API_KEY"),
      maxRetries: 0,
      fetch,
    });
    return {
      adapter: anthropic(),
      upstream: await client.messages.create(
        {
          model: env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
          max_tokens: 2048,
          messages,
          stream: true,
        },
        { signal },
      ),
    };
  }
  if (protocol === "langgraph") {
    const client = new Client({
      apiUrl: required(env, "LANGGRAPH_API_URL"),
      apiKey: required(env, "LANGGRAPH_API_KEY"),
      callerOptions: { fetch, maxRetries: 0 },
    });
    return {
      adapter: langGraph(),
      upstream: client.runs.stream(
        null,
        required(env, "LANGGRAPH_ASSISTANT_ID"),
        {
          input: { messages },
          streamMode: ["messages-tuple"],
          signal,
          onDisconnect: "cancel",
        },
      ),
    };
  }
  const apiKey = required(env, "OPENAI_API_KEY");
  const model = env.OPENAI_MODEL || "gpt-4.1-mini";
  if (protocol === "ai-sdk") {
    const provider = createOpenAI({ apiKey, fetch });
    const result = streamText({
      model: provider(model),
      messages,
      abortSignal: signal,
      maxOutputTokens: 2048,
      maxRetries: 0,
    });
    return {
      adapter: aiSDK(),
      upstream: result.toUIMessageStream({
        onError: () => "The model stream failed. Please retry.",
      }),
    };
  }
  const client = new OpenAI({ apiKey, maxRetries: 0, fetch });
  if (protocol === "chat-completions") {
    return {
      adapter: chatCompletions(),
      upstream: await client.chat.completions.create(
        {
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: 2048,
        },
        { signal },
      ),
    };
  }
  const upstream = await client.responses.create(
    {
      model,
      input: messages,
      stream: true,
      store: false,
      max_output_tokens: 2048,
    },
    { signal },
  );
  if (protocol === "agui") {
    const adapter = agUI({
      threadId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    });
    return {
      adapter,
      upstream: eventport
        .convert(upstream, { signal })
        .from(responses())
        .to(adapter),
    };
  }
  return { adapter: responses(), upstream };
}

export function convertedResponse({ protocol, upstream, adapter, signal }) {
  const pending = [];
  const record = (stage, event) => {
    // Bound trace buffering even when upstream emits many non-rendering events.
    if (
      event?.type === "error" ||
      event?.event === "error" ||
      event?.type === "response.failed"
    )
      event = {
        type: "error",
        message: "The upstream model reported an error.",
      };
    if (pending.length < 100)
      pending.push({
        type: "data-eventport-trace",
        transient: true,
        data: { stage, protocol, event },
      });
  };
  const converted = eventport
    .convert(upstream, { signal })
    .from(adapter, { observe: (event) => record("source", event) })
    .to(aiSDK())
    .onUnsupported((diagnostic) => {
      record("unsupported", {
        adapter: diagnostic.adapter,
        reason: diagnostic.reason,
      });
      return "drop";
    });
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      for await (const event of converted) {
        for (const trace of pending.splice(0)) writer.write(trace);
        // Do not expose raw upstream error strings to the browser.
        const output =
          event.type === "error"
            ? { ...event, errorText: "The model stream failed. Please retry." }
            : event;
        writer.write(output);
        writer.write({
          type: "data-eventport-trace",
          transient: true,
          data: { stage: "output", protocol, event: output },
        });
      }
      for (const trace of pending.splice(0)) writer.write(trace);
    },
    onError: () =>
      signal?.aborted
        ? "The request was cancelled or timed out."
        : "The model stream failed. Check the server configuration and retry.",
  });
  return createUIMessageStreamResponse({
    stream,
    headers: { "Cache-Control": "no-store", "X-Eventport-Source": protocol },
  });
}
