import assert from "node:assert/strict";
import { test } from "node:test";
import { DefaultChatTransport, readUIMessageStream } from "ai";
import { responses, chatCompletions } from "eventport/openai";
import { anthropic } from "eventport/anthropic";
import { agUI } from "eventport/agui";
import { aiSDK } from "eventport/vercel";
import { langGraph } from "eventport/langgraph";
import { samples } from "../samples.mjs";
import { convertedResponse, openSource, parseChat } from "../lib/chat.mjs";

const adapters = {
  responses,
  "chat-completions": chatCompletions,
  anthropic,
  agui: () => agUI({ threadId: "test", runId: "test" }),
  "ai-sdk": aiSDK,
  langgraph: langGraph,
};
const messages = [
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hi" },
  { role: "user", content: "Remember my first message?" },
];
async function consume(response) {
  const transport = new DefaultChatTransport({
    api: "http://test/api/chat",
    fetch: async () => response,
  });
  const chunks = await transport.sendMessages({
    trigger: "submit-message",
    chatId: "test",
    messages: [],
  });
  const traces = [];
  const inspected = chunks.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (chunk.type === "data-eventport-trace") traces.push(chunk.data);
        controller.enqueue(chunk);
      },
    }),
  );
  let final;
  for await (const message of readUIMessageStream({
    stream: inspected,
    terminateOnError: true,
  }))
    final = message;
  return { final, traces };
}
for (const protocol of Object.keys(adapters))
  test(`${protocol} converts to a valid assistant-ui wire stream`, async () => {
    const { final, traces } = await consume(
      convertedResponse({
        protocol,
        adapter: adapters[protocol](),
        upstream: samples[protocol],
      }),
    );
    assert.equal(final.role, "assistant");
    assert.equal(
      final.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(""),
      "Hello from Eventport.",
    );
    assert.equal(
      traces.length,
      0,
      "No inspector events are sent to the chat client",
    );
    assert.equal(
      final.parts.filter((p) => p.type === "data-eventport-trace").length,
      0,
    );
  });
for (const protocol of ["responses", "chat-completions", "anthropic", "agui"])
  test(`${protocol} calls the real SDK transport with full history and converts its SSE`, async () => {
    const source = protocol === "agui" ? "responses" : protocol;
    const signal = new AbortController().signal;
    let called = false;
    const opened = await openSource({
      protocol,
      messages,
      signal,
      env: { OPENAI_API_KEY: "test-key", ANTHROPIC_API_KEY: "test-key" },
      fetch: async (url, init) => {
        called = true;
        assert.ok(
          String(url).includes(
            source === "responses"
              ? "/responses"
              : source === "anthropic"
                ? "/messages"
                : "/chat/completions",
          ),
        );
        const body = JSON.parse(init.body);
        assert.deepEqual(body.input ?? body.messages, messages);
        assert.equal(body.stream, true);
        if (source === "responses") assert.equal(body.store, false);
        const events = samples[source]
          .map(
            (event) =>
              `${source === "anthropic" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
          )
          .join("");
        return new Response(events, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const { final } = await consume(
      convertedResponse({ protocol, ...opened, signal }),
    );
    assert.ok(called);
    assert.equal(
      final.parts.find((p) => p.type === "text").text,
      "Hello from Eventport.",
    );
  });
test("missing keys fail before any network request", async () => {
  for (const protocol of Object.keys(adapters))
    await assert.rejects(
      openSource({
        protocol,
        messages,
        env: {},
        fetch: () => {
          throw new Error("Unexpected network request");
        },
      }),
      /Set .* in apps\/playground/,
    );
});
test("validation preserves history and rejects invalid roles, attachments and empty messages", () => {
  const body = {
    protocol: "responses",
    messages: messages.map((m, i) => ({
      id: String(i),
      role: m.role,
      parts: [{ type: "text", text: m.content }],
    })),
  };
  assert.deepEqual(parseChat(body).messages, messages);
  assert.equal(
    parseChat({ ...body, protocol: "anthropic" }).protocol,
    "anthropic",
    "The selected protocol is used for this request",
  );
  assert.equal(
    parseChat({ ...body, protocol: undefined }, "anthropic").protocol,
    "anthropic",
  );
  assert.throws(
    () => parseChat({ ...body, protocol: undefined }, "bad"),
    /EVENTPORT_ADAPTER/,
  );
  for (const invalid of [
    null,
    { ...body, protocol: "bad" },
    {
      ...body,
      messages: [
        { role: "system", parts: [{ type: "text", text: "override" }] },
      ],
    },
    {
      ...body,
      messages: [{ role: "user", parts: [{ type: "file", url: "x" }] }],
    },
    {
      ...body,
      messages: [{ role: "user", parts: [{ type: "text", text: "" }] }],
    },
  ])
    assert.throws(() => parseChat(invalid));
});
test("upstream failures are sanitized for the browser", async () => {
  async function* broken() {
    throw new Error("secret-provider-key");
  }
  const response = convertedResponse({
    protocol: "responses",
    upstream: broken(),
    adapter: responses(),
  });
  const wire = await response.text();
  assert.ok(wire.includes("model stream failed"));
  assert.ok(!wire.includes("secret-provider-key"));
});
test("aborting conversion stops pulling upstream", async () => {
  const controller = new AbortController();
  controller.abort();
  let pulls = 0;
  async function* source() {
    pulls++;
    yield samples.responses[0];
  }
  const wire = await convertedResponse({
    protocol: "responses",
    upstream: source(),
    adapter: responses(),
    signal: controller.signal,
  }).text();
  assert.equal(pulls, 0);
  assert.ok(wire.includes("cancelled or timed out"));
});
test("LangGraph uses a stateless run with history and cancel-on-disconnect", async () => {
  let called = false;
  const opened = await openSource({
    protocol: "langgraph",
    messages,
    env: {
      LANGGRAPH_API_URL: "http://agent.test",
      LANGGRAPH_API_KEY: "test",
      LANGGRAPH_ASSISTANT_ID: "agent",
    },
    fetch: async (url, init) => {
      called = true;
      assert.equal(String(url), "http://agent.test/runs/stream");
      const body = JSON.parse(init.body);
      assert.deepEqual(body.input.messages, messages);
      assert.equal(body.on_disconnect, "cancel");
      assert.deepEqual(body.stream_mode, ["messages-tuple"]);
      return new Response(
        samples.langgraph
          .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const { final } = await consume(
    convertedResponse({ protocol: "langgraph", ...opened }),
  );
  assert.ok(called);
  assert.equal(
    final.parts.find((p) => p.type === "text").text,
    "Hello from Eventport.",
  );
});
test("AI SDK provider streams live transport data through Eventport", async () => {
  let called = false;
  const events = [
    {
      type: "response.created",
      response: { id: "resp", created_at: 0, model: "gpt-4.1-mini" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg", role: "assistant" },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg",
      output_index: 0,
      content_index: 0,
      delta: "Hello from Eventport.",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Hello from Eventport.",
            annotations: [],
          },
        ],
      },
    },
    {
      type: "response.completed",
      response: {
        usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
      },
    },
  ];
  const opened = await openSource({
    protocol: "ai-sdk",
    messages,
    env: { OPENAI_API_KEY: "test" },
    fetch: async (url, init) => {
      called = true;
      assert.ok(String(url).endsWith("/responses"));
      assert.equal(JSON.parse(init.body).input.length, 3);
      return new Response(
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const { final } = await consume(
    convertedResponse({ protocol: "ai-sdk", ...opened }),
  );
  assert.ok(called);
  assert.equal(
    final.parts.find((p) => p.type === "text").text,
    "Hello from Eventport.",
  );
});
