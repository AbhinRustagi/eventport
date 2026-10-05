import assert from "node:assert/strict";
import { test } from "node:test";
import { eventport } from "eventport";
import { anthropic } from "eventport/anthropic";
import { aiSDK } from "eventport/vercel";
import { chatCompletions, responses } from "eventport/openai";
import { langGraph } from "eventport/langgraph";
import { adapters, text } from "./helpers.mjs";
import { samples } from "./fixtures/streams.mjs";
const thinking = [
  samples.anthropic[0],
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Inspecting the request." },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "signed" },
  },
  { type: "content_block_stop", index: 0 },
  samples.anthropic.at(-2),
  samples.anthropic.at(-1),
];

test("Anthropic reasoning round trip retains text and native signature", async () => {
  const result = await eventport
    .convert(thinking)
    .from(anthropic())
    .to(anthropic())
    .collect();
  const deltas = result
    .filter((e) => e.type === "content_block_delta")
    .map((e) => e.delta);
  assert.ok(deltas.some((e) => e.thinking === "Inspecting the request."));
  assert.ok(deltas.some((e) => e.signature === "signed"));
});
test("unsigned reasoning is not silently accepted as replayable Anthropic thinking", async () => {
  await assert.rejects(
    () =>
      eventport
        .convert(thinking.filter((e) => e.delta?.type !== "signature_delta"))
        .from(anthropic())
        .to(anthropic())
        .collect(),
    /signature/,
  );
});
const approvals = [
  ...samples["ai-sdk"].slice(0, -1),
  {
    type: "tool-approval-request",
    approvalId: "approval_1",
    toolCallId: "call_weather",
  },
  samples["ai-sdk"].at(-1),
];
test("approval IDs and tool IDs survive AI SDK → AG-UI → AI SDK", async () => {
  const ag = await eventport
    .convert(approvals)
    .from(aiSDK())
    .to(adapters.agui())
    .collect();
  const interrupt = ag.at(-1).outcome.interrupts[0];
  assert.equal(interrupt.id, "approval_1");
  assert.equal(interrupt.toolCallId, "call_weather");
  const out = await eventport
    .convert(ag)
    .from(adapters.agui())
    .to(aiSDK())
    .collect();
  const request = out.find((e) => e.type === "tool-approval-request");
  assert.equal(request.approvalId, "approval_1");
  assert.equal(request.toolCallId, "call_weather");
});
test("Chat Completions reports unsupported approvals", async () => {
  await assert.rejects(
    () =>
      eventport
        .convert(approvals)
        .from(aiSDK())
        .to(chatCompletions())
        .collect(),
    /interaction.requested/,
  );
});
test("parallel interleaved tool arguments stay attached to the correct calls", async () => {
  const chunks = [
    samples["chat-completions"][0],
    ...[
      [
        {
          index: 0,
          id: "one",
          function: { name: "first", arguments: '{"a":' },
        },
        {
          index: 1,
          id: "two",
          function: { name: "second", arguments: '{"b":' },
        },
      ],
      [
        { index: 1, function: { arguments: "2}" } },
        { index: 0, function: { arguments: "1}" } },
      ],
    ].map((tool_calls) => ({
      ...samples["chat-completions"][1],
      choices: [{ index: 0, delta: { tool_calls }, finish_reason: null }],
    })),
    samples["chat-completions"].at(-2),
  ];
  const out = await eventport
    .convert(chunks)
    .from(chatCompletions())
    .to(aiSDK())
    .collect();
  assert.deepEqual(
    out
      .filter((e) => e.type === "tool-input-available")
      .map((e) => [e.toolCallId, e.toolName, e.input]),
    [
      ["one", "first", { a: 1 }],
      ["two", "second", { b: 2 }],
    ],
  );
});
test("Responses output has ordered sequence numbers and a completed text snapshot", async () => {
  const out = await eventport
    .convert(samples["ai-sdk"])
    .from(aiSDK())
    .to(responses())
    .collect();
  assert.deepEqual(
    out.map((e) => e.sequence_number),
    out.map((_, i) => i),
  );
  const final = out.at(-1);
  assert.equal(final.type, "response.completed");
  assert.equal(final.response.output_text, "Hello from Eventport.");
  assert.equal(
    final.response.output.find((e) => e.type === "function_call").arguments,
    '{"city":"London"}',
  );
});
test("Chat Completions usage after finish_reason reaches the output", async () => {
  const out = await eventport
    .convert(samples["chat-completions"])
    .from(chatCompletions())
    .to(responses())
    .collect();
  assert.equal(out.at(-1).response.usage.total_tokens, 20);
});
test("LangGraph tuple input uses the same conversion as envelopes", async () => {
  const out = await eventport
    .convert(samples.langgraph.map((e) => [e.event, e.data]))
    .from(langGraph({ input: "tuples" }))
    .to(aiSDK())
    .collect();
  assert.equal(text(out), "Hello from Eventport.");
});
test("LangGraph resolves a tool result in a later graph step", async () => {
  const events = [
    ...samples.langgraph,
    {
      event: "messages",
      data: [
        {
          type: "tool",
          id: "result",
          tool_call_id: "call_weather",
          content: "sunny",
        },
        { langgraph_step: 2, langgraph_node: "tools" },
      ],
    },
  ];
  const out = await eventport
    .convert(events)
    .from(langGraph())
    .to(aiSDK())
    .collect();
  const call = out.find((e) => e.type === "tool-input-available");
  const result = out.find((e) => e.type === "tool-output-available");
  assert.equal(result.toolCallId, call.toolCallId);
  assert.equal(result.output, "sunny");
});
for (const [label, events, pattern] of [
  [
    "text without start",
    [{ type: "start" }, { type: "text-delta", id: "missing", delta: "x" }],
    /without start/,
  ],
  [
    "invalid tool JSON",
    [
      { type: "start" },
      { type: "tool-input-start", toolCallId: "t", toolName: "f" },
      { type: "tool-input-delta", toolCallId: "t", inputTextDelta: "{" },
      {
        type: "tool-input-available",
        toolCallId: "t",
        toolName: "f",
        input: {},
      },
    ],
    /JSON|arguments/i,
  ],
  [
    "orphan tool result",
    [
      { type: "start" },
      { type: "tool-output-available", toolCallId: "missing", output: "x" },
    ],
    /completed input/,
  ],
  [
    "orphan approval",
    [
      { type: "start" },
      { type: "tool-approval-request", approvalId: "a", toolCallId: "missing" },
    ],
    /completed input/,
  ],
])
  test(`rejects ${label}`, async () => {
    await assert.rejects(
      () =>
        eventport.convert(events).from(aiSDK()).to(adapters.agui()).collect(),
      pattern,
    );
  });

test("LangGraph tuple middleware distinguishes a single tuple from a list of tuples", async () => {
  const out = await eventport
    .convert(samples.langgraph.map((e) => [e.event, e.data]))
    .from(langGraph({ input: "tuples" }), {
      middleware: {
        metadata: (event) => event,
        messages: (event) => {
          const [message, metadata] = event[1];
          if (message.content === "Hello from ")
            return [
              event,
              ["messages", [{ ...message, content: "again " }, metadata]],
            ];
          if (message.content === "Eventport.") return null;
          return event;
        },
      },
    })
    .to(aiSDK())
    .collect();
  assert.equal(text(out), "Hello from again ");
  assert.equal(out.filter((e) => e.type === "tool-input-available").length, 1);
});

test("every source adapter emits AG-UI at the shared adapter interface", async () => {
  const context = {
    unsupported: async () => {
      throw new Error("Unexpected unsupported event");
    },
  };
  for (const [name, events] of Object.entries(samples)) {
    const decoder = adapters[name]().decoder(context);
    const output = [];
    for (const event of events) output.push(...(await decoder.push(event)));
    output.push(...(await decoder.finish()));
    assert.ok(
      output.every((event) => /^[A-Z_]+$/.test(event.type)),
      name,
    );
    const start = output.find((event) => event.type === "RUN_STARTED");
    const end = output.at(-1);
    assert.equal(end.type, "RUN_FINISHED", name);
    assert.equal(end.runId, start.runId, name);
    assert.equal(end.threadId, start.threadId, name);
    assert.ok(
      output.some((event) => event.type === "TEXT_MESSAGE_CONTENT"),
      name,
    );
    assert.ok(
      output.some((event) => event.type === "TOOL_CALL_ARGS"),
      name,
    );
  }
});

test("AG-UI passthrough retains native fields and protocol-only events", async () => {
  const events = [
    {
      type: "RUN_STARTED",
      threadId: "thread_demo",
      runId: "run_demo",
      protocolVersion: "1.0",
      parentRunId: "parent",
      metadata: { app: "test" },
    },
    {
      type: "MESSAGES_SNAPSHOT",
      messages: [{ id: "u", role: "user", content: "Hello" }],
    },
    {
      type: "ACTIVITY_SNAPSHOT",
      messageId: "a",
      activityType: "progress",
      content: { percent: 50 },
    },
    { type: "STATE_SNAPSHOT", snapshot: { count: 1 } },
    {
      type: "STATE_DELTA",
      delta: [{ op: "replace", path: "/count", value: 2 }],
    },
    {
      type: "TEXT_MESSAGE_START",
      messageId: "m",
      role: "assistant",
      timestamp: 123,
      metadata: { provider: "native" },
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m",
      delta: "Hello",
      rawEvent: { original: true },
    },
    { type: "TEXT_MESSAGE_END", messageId: "m" },
    { type: "RAW", source: "provider", event: { opaque: true } },
    { type: "CUSTOM", name: "application.event", value: { count: 1 } },
    {
      type: "RUN_FINISHED",
      threadId: "thread_demo",
      runId: "run_demo",
      result: { ok: true },
      usage: [{ inputTokens: 2, outputTokens: 3 }],
      outcome: { type: "success" },
    },
  ];
  const output = await eventport
    .from(adapters.agui())
    .to(adapters.agui())
    .convert(events)
    .collect();
  assert.deepEqual(output, events);
  await assert.rejects(
    () =>
      eventport.from(adapters.agui()).to(responses()).convert(events).collect(),
    /MESSAGES_SNAPSHOT/,
  );
});

test("AG-UI terminal usage reaches provider output", async () => {
  const events = structuredClone(samples.agui);
  events.at(-1).usage = [
    { provider: "one", inputTokens: 10, outputTokens: 4 },
    { provider: "two", inputTokens: 2, outputTokens: 3, totalTokens: 5 },
  ];
  const output = await eventport
    .from(adapters.agui())
    .to(responses())
    .convert(events)
    .collect();
  assert.equal(output.at(-1).response.usage.input_tokens, 12);
  assert.equal(output.at(-1).response.usage.output_tokens, 7);
  assert.equal(output.at(-1).response.usage.total_tokens, 19);
});

test("reasoning signatures survive Anthropic → AG-UI → Anthropic", async () => {
  const events = await eventport
    .from(anthropic())
    .to(adapters.agui())
    .convert(thinking)
    .collect();
  assert.ok(events.some((e) => e.type === "REASONING_MESSAGE_CONTENT"));
  const output = await eventport
    .from(adapters.agui())
    .to(anthropic())
    .convert(JSON.parse(JSON.stringify(events)))
    .collect();
  assert.ok(output.some((e) => e.delta?.signature === "signed"));
});

test("structured tool results and errors survive AG-UI storage", async () => {
  for (const result of [
    {
      type: "tool-output-available",
      toolCallId: "call_weather",
      output: { temperature: 21 },
    },
    {
      type: "tool-output-error",
      toolCallId: "call_weather",
      errorText: "Unavailable",
    },
  ]) {
    const input = [
      ...samples["ai-sdk"].slice(0, -1),
      result,
      samples["ai-sdk"].at(-1),
    ];
    const events = await eventport
      .from(aiSDK())
      .to(adapters.agui())
      .convert(input)
      .collect();
    const output = await eventport
      .from(adapters.agui())
      .to(aiSDK())
      .convert(JSON.parse(JSON.stringify(events)))
      .collect();
    const converted = output.find((e) => e.type === result.type);
    assert.equal(converted.toolCallId, result.toolCallId);
    assert.deepEqual(
      converted.output ?? converted.errorText,
      result.output ?? result.errorText,
    );
  }
});

test("AG-UI native interrupt outcomes emit one approval and preserve cancellation", async () => {
  const events = structuredClone(samples.agui);
  events.at(-1).outcome = {
    type: "interrupt",
    interrupts: [
      { id: "approve", reason: "approval", toolCallId: "call_weather" },
    ],
  };
  const output = await eventport
    .from(adapters.agui())
    .to(aiSDK())
    .convert(events)
    .collect();
  assert.equal(
    output.filter((e) => e.type === "tool-approval-request").length,
    1,
  );
  assert.equal(
    output.find((e) => e.type === "tool-approval-request").approvalId,
    "approve",
  );
  events.at(-1).outcome = { type: "cancelled" };
  const cancelled = await eventport
    .from(adapters.agui())
    .to(aiSDK())
    .convert(events)
    .collect();
  assert.equal(cancelled.at(-1).type, "abort");
});

test("AG-UI rejects mismatched reasoning content and run identities", async () => {
  const start = samples.agui[0];
  for (const events of [
    [
      start,
      { type: "TEXT_MESSAGE_START", messageId: "m" },
      { type: "REASONING_MESSAGE_CONTENT", messageId: "m", delta: "bad" },
    ],
    [start, { ...samples.agui.at(-1), runId: "different-run" }],
  ]) {
    await assert.rejects(
      () =>
        eventport
          .from(adapters.agui())
          .to(adapters.agui())
          .convert(events)
          .collect(),
      /missing block start|identity/,
    );
  }
});
