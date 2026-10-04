import assert from "node:assert/strict";
import { test } from "node:test";
import { eventport } from "eventport";
import { aiSDK } from "eventport/vercel";
import { adapters, calls, text, live, readable } from "./helpers.mjs";
import { samples } from "./fixtures/streams.mjs";

for (const [source, fixture] of Object.entries(samples)) {
  for (const target of Object.keys(adapters).filter(
    (name) => name !== "langgraph",
  )) {
    test(`${source} → ${target}: stored, iterable, readable and SSE retain text and tools`, async () => {
      const convert = (input) =>
        eventport
          .convert(input)
          .from(adapters[source]())
          .to(adapters[target]());
      const expected = {
        text: "Hello from Eventport.",
        calls: [{ name: "weather", input: { city: "London" } }],
      };
      const verify = async (output) => {
        const decoded = await eventport
          .convert(output)
          .from(adapters[target]())
          .to(aiSDK())
          .collect();
        assert.deepEqual(
          { text: text(decoded), calls: calls(decoded) },
          expected,
        );
        assert.equal(decoded.at(-1).type, "finish");
      };
      for (const input of [
        structuredClone(fixture),
        live(structuredClone(fixture)),
        readable(structuredClone(fixture)),
      ]) {
        await verify(await convert(input).collect());
      }
      const response = convert(structuredClone(fixture)).toResponse();
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      if (target === "ai-sdk")
        assert.equal(
          response.headers.get("x-vercel-ai-uimessage-stream"),
          "v1",
        );
      const frames = (await response.text()).trim().split("\n\n");
      if (["chat-completions", "ai-sdk"].includes(target))
        assert.equal(frames.pop(), "data: [DONE]");
      const events = frames.map((frame) => {
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        assert.ok(data, `Missing SSE data: ${frame}`);
        const event = JSON.parse(data.slice(6));
        if (["responses", "anthropic"].includes(target))
          assert.ok(frame.includes(`event: ${event.type}\n`));
        return event;
      });
      await verify(events);
    });
  }
}
